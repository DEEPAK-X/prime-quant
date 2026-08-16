/**
 * PrimeQuant GUI <-> backend bridge.
 *
 * The backend (daemon) on localhost:3001 exposes:
 *   - a WebSocket event stream at `/ws`
 *   - JSON REST endpoints under `/api` (subagents, artifacts, latest tearsheet)
 *
 * Event schema (server -> client):
 *   { type: "chat",      role: "user"|"assistant", text: string, id?: string }
 *   { type: "step",      id: string, name: "ast_check"|"backtest"|"cpcv_gate", status: "running"|"done"|"error", detail?: string }
 *   { type: "subagent",  id, name, tier, status: "RUNNING"|"DONE"|"ERROR", tokensPerMin?, task? }
 *   { type: "tearsheet", url: string }
 *   { type: "artifact",  kind: "py"|"mq5", name: string, content: string }
 *
 * Client -> server: { type: "chat", text: string }
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type StepName = "ast_check" | "backtest" | "cpcv_gate";
export type StepStatus = "running" | "done" | "error";
export type SubagentStatus = "RUNNING" | "DONE" | "ERROR";
export type ArtifactKind = "py" | "mq5";
export type ConnectionState = "connecting" | "open" | "closed";

export interface StepEvent {
	type: "step";
	id: string;
	name: StepName;
	status: StepStatus;
	detail?: string;
}

export interface ChatEvent {
	type: "chat";
	role: "user" | "assistant";
	text: string;
	id?: string;
}

export interface SubagentEvent {
	type: "subagent";
	id: string;
	name: string;
	tier: string;
	status: SubagentStatus;
	tokensPerMin?: number;
	task?: string;
}

export interface TearsheetEvent {
	type: "tearsheet";
	url: string;
}

export interface ArtifactEvent {
	type: "artifact";
	kind: ArtifactKind;
	name: string;
	content: string;
}

export type QuantEvent = StepEvent | ChatEvent | SubagentEvent | TearsheetEvent | ArtifactEvent;

export interface ArtifactStore {
	py: ArtifactEvent[];
	mq5: ArtifactEvent[];
}

function isQuantEvent(value: unknown): value is QuantEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Record<string, unknown>;
	switch (event.type) {
		case "chat":
			return event.role === "user" || event.role === "assistant";
		case "step":
			return typeof event.id === "string" && typeof event.name === "string" && typeof event.status === "string";
		case "subagent":
			return typeof event.id === "string" && typeof event.name === "string" && typeof event.status === "string";
		case "tearsheet":
			return typeof event.url === "string";
		case "artifact":
			return (event.kind === "py" || event.kind === "mq5") && typeof event.content === "string";
		default:
			return false;
	}
}

function wsEndpoint(): string {
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${window.location.host}/ws`;
}

function apiUrl(path: string): string {
	return `/api${path}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
	try {
		const response = await fetch(apiUrl(path));
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

interface SubagentsResponse {
	subagents?: SubagentEvent[];
}

interface ArtifactsResponse {
	artifacts?: ArtifactEvent[];
}

interface TearsheetResponse {
	url?: string;
}

function upsertSubagent(existing: Record<string, SubagentEvent>, event: SubagentEvent): Record<string, SubagentEvent> {
	return { ...existing, [event.id]: event };
}

function upsertArtifact(list: ArtifactEvent[], event: ArtifactEvent): ArtifactEvent[] {
	return [...list.filter((entry) => entry.name !== event.name), event];
}

export interface QuantSocket {
	connection: ConnectionState;
	messages: ChatEvent[];
	steps: Record<string, StepEvent>;
	subagents: Record<string, SubagentEvent>;
	tearsheetUrl: string | null;
	artifacts: ArtifactStore;
	sendMessage: (text: string) => void;
}

/**
 * Owns the WebSocket lifecycle (exponential backoff reconnect) and merges the
 * REST snapshots (subagents / artifacts / latest tearsheet) on connect.
 */
export function useQuantSocket(): QuantSocket {
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [messages, setMessages] = useState<ChatEvent[]>([]);
	const [steps, setSteps] = useState<Record<string, StepEvent>>({});
	const [subagents, setSubagents] = useState<Record<string, SubagentEvent>>({});
	const [tearsheetUrl, setTearsheetUrl] = useState<string | null>(null);
	const [artifacts, setArtifacts] = useState<ArtifactStore>({ py: [], mq5: [] });
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | null = null;
		let retryTimer: number | undefined;
		let attempts = 0;

		const connect = () => {
			setConnection("connecting");
			socket = new WebSocket(wsEndpoint());
			socketRef.current = socket;
			socket.onopen = () => {
				attempts = 0;
				setConnection("open");
				void fetchJson<SubagentsResponse>("/subagents").then((data) => {
					const subagents = data?.subagents;
					if (disposed || !subagents) return;
					setSubagents((prev) => subagents.reduce(upsertSubagent, prev));
				});
				void fetchJson<ArtifactsResponse>("/artifacts?kind=py").then((data) => {
					const artifacts = data?.artifacts;
					if (disposed || !artifacts) return;
					setArtifacts((prev) => ({ ...prev, py: [...prev.py, ...artifacts] }));
				});
				void fetchJson<ArtifactsResponse>("/artifacts?kind=mq5").then((data) => {
					const artifacts = data?.artifacts;
					if (disposed || !artifacts) return;
					setArtifacts((prev) => ({ ...prev, mq5: [...prev.mq5, ...artifacts] }));
				});
				void fetchJson<TearsheetResponse>("/tearsheet/latest").then((data) => {
					if (disposed || !data?.url) return;
					setTearsheetUrl(data.url);
				});
			};

			socket.onmessage = (event) => {
				let payload: unknown;
				try {
					payload = JSON.parse(String(event.data)) as unknown;
				} catch {
					return;
				}
				if (!isQuantEvent(payload)) return;
				switch (payload.type) {
					case "chat":
						setMessages((prev) => {
							// The client appends user messages optimistically; a
							// server echo of the same text must not duplicate it.
							if (payload.role === "user" && prev.length > 0) {
								const last = prev[prev.length - 1];
								if (last.role === "user" && last.text === payload.text) return prev;
							}
							return [...prev, payload];
						});
						break;
					case "step":
						setSteps((prev) => ({ ...prev, [payload.id]: payload }));
						break;
					case "subagent":
						setSubagents((prev) => upsertSubagent(prev, payload));
						break;
					case "tearsheet":
						setTearsheetUrl(payload.url);
						break;
					case "artifact":
						setArtifacts((prev) => ({ ...prev, [payload.kind]: upsertArtifact(prev[payload.kind], payload) }));
						break;
				}
			};

			socket.onerror = () => {
				socket?.close();
			};

			socket.onclose = () => {
				if (disposed) return;
				setConnection("closed");
				const delay = Math.min(1000 * 2 ** attempts, 15000);
				attempts += 1;
				retryTimer = window.setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			disposed = true;
			if (retryTimer !== undefined) window.clearTimeout(retryTimer);
			socket?.close();
			socketRef.current = null;
		};
	}, []);

	const sendMessage = useCallback((text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		setMessages((prev) => [...prev, { type: "chat", role: "user", text: trimmed, id: `local-${Date.now()}` }]);
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify({ type: "chat", text: trimmed }));
		}
	}, []);

	return { connection, messages, steps, subagents, tearsheetUrl, artifacts, sendMessage };
}
