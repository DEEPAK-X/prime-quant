/**
 * PrimeQuant GUI <-> backend bridge (v2 contract).
 *
 * The backend (demo or real bridge) on localhost:3001 exposes:
 *   - a WebSocket event stream at `/ws`
 *   - JSON REST endpoints under `/api` (subagents, artifacts, tearsheets, mt5)
 *
 * Event schema is defined in `contract.ts` (mirrors the frozen doc 02). The
 * demo backend speaks protocol v1 (no hello/chat_delta/thinking/card); the
 * real bridge speaks protocol v2. The store accepts both and flips into demo
 * mode when no `hello` with protocol 2 arrives within 2s of connect.
 *
 * Streaming budget: chat_delta frames can arrive at 50/s. Per-delta setState
 * would drop frames, so deltas are accumulated in a ref and flushed once per
 * animation frame (rAF batching) — one setMessages per frame regardless of
 * delta count. The reconnect/backoff logic is unchanged from the v1 store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type AgentState,
	type ArtifactEvent,
	type ArtifactStore,
	type CardEvent,
	type ClientMessage,
	type ConnectionState,
	type ErrorEvent,
	emptyArtifactStore,
	type HelloEvent,
	isServerEvent,
	type Mt5State,
	type Protocol,
	type RoomInfo,
	type RoomMessageEvent,
	type ServerEvent,
	type StepEvent,
	type SubagentEvent,
	type TearsheetEntry,
	upsertArtifact,
	upsertSubagent,
} from "./contract";
import type { MockSocket } from "./mock-socket";
import { createMockSocket, shouldUseMockSocket } from "./mock-socket";
import {
	applyChat,
	applyChatDelta,
	applyThinking,
	type ChatMessage,
	MAX_MESSAGES,
	type ThinkingBlock,
} from "./reducer";

/** Transport surface both the real WebSocket and MockSocket satisfy. */
type SocketTransport = WebSocket | MockSocket;

/** readyState value for an open socket (WebSocket.OPEN / MockSocket open). */
const SOCKET_OPEN = 1;

export type {
	AgentState,
	ArtifactKind,
	ArtifactStore,
	Backend,
	CardEvent,
	CardMetric,
	CardPayload,
	ChatDeltaEvent,
	ChatEvent,
	ClientMessage,
	ConnectionState,
	ErrorEvent,
	ErrorScope,
	HelloEvent,
	KnownStepName,
	Mt5Detail,
	Mt5State,
	Protocol,
	RoomInfo,
	RoomMessageEvent,
	RoomsStateEvent,
	ServerEvent,
	StepEvent,
	StepStatus,
	SubagentEvent,
	SubagentStatus,
	TearsheetEntry,
	TearsheetEvent,
	ThinkingEvent,
	ValidationGate,
} from "./contract";
export type { ChatMessage, ThinkingBlock } from "./reducer";

export interface QuantError extends ErrorEvent {
	readonly ts: string;
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

interface TearsheetLatestResponse {
	url?: string;
	name?: string;
	ts?: string;
}

interface TearsheetsResponse {
	tearsheets?: TearsheetEntry[];
}

interface RoomsResponse {
	rooms?: RoomInfo[];
}

interface RoomMessagesResponse {
	messages?: RoomMessageEvent[];
}

interface HealthResponse {
	ok?: boolean;
	backend?: string;
	agentState?: AgentState;
}

type Mt5Response = Mt5State;

const DEMO_TIMEOUT_MS = 2000;
const MAX_ERRORS = 20;
const MAX_TEARSHEETS = 50;

/** Initial state shared by every fresh connect (snapshots rebuild it). */
const UNKNOWN_MT5: Mt5State = { status: "unknown", detail: null };

export interface QuantSocket {
	connection: ConnectionState;
	protocol: Protocol | null;
	backend: string | null;
	agentState: AgentState | null;
	mt5: Mt5State;
	sessionId: string | null;
	demo: boolean;
	messages: ChatMessage[];
	thinking: Record<string, ThinkingBlock>;
	steps: Record<string, StepEvent>;
	subagents: Record<string, SubagentEvent>;
	cards: Record<string, CardEvent>;
	tearsheets: TearsheetEntry[];
	tearsheetUrl: string | null;
	artifacts: ArtifactStore;
	rooms: RoomInfo[];
	roomMessages: Record<string, RoomMessageEvent[]>;
	errors: QuantError[];
	sendMessage: (text: string) => void;
	interrupt: () => void;
	refreshMt5: () => void;
}

/**
 * Owns the WebSocket lifecycle (exponential backoff reconnect, unchanged from
 * v1), merges the REST snapshots on connect, and reduces every v2 event into
 * typed state slices. chat_delta frames are batched through rAF so a 50/s
 * stream produces at most one setMessages per animation frame.
 */
export function useQuantSocket(): QuantSocket {
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [protocol, setProtocol] = useState<Protocol | null>(null);
	const [backend, setBackend] = useState<string | null>(null);
	const [agentState, setAgentState] = useState<AgentState | null>(null);
	const [mt5, setMt5] = useState<Mt5State>(UNKNOWN_MT5);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [demo, setDemo] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [thinking, setThinking] = useState<Record<string, ThinkingBlock>>({});
	const [steps, setSteps] = useState<Record<string, StepEvent>>({});
	const [subagents, setSubagents] = useState<Record<string, SubagentEvent>>({});
	const [cards, setCards] = useState<Record<string, CardEvent>>({});
	const [tearsheets, setTearsheets] = useState<TearsheetEntry[]>([]);
	const [tearsheetUrl, setTearsheetUrl] = useState<string | null>(null);
	const [artifacts, setArtifacts] = useState<ArtifactStore>(emptyArtifactStore());
	const [rooms, setRooms] = useState<RoomInfo[]>([]);
	const [roomMessages, setRoomMessages] = useState<Record<string, RoomMessageEvent[]>>({});
	const [errors, setErrors] = useState<QuantError[]>([]);
	const socketRef = useRef<SocketTransport | null>(null);

	// rAF-batched chat_delta accumulator: deltas pile up in this ref and are
	// flushed as a single setMessages on the next animation frame.
	const deltaBuffer = useRef<Map<string, { id: string; chunks: string[] }>>(new Map());
	const rafHandle = useRef<number | null>(null);

	const flushDeltas = useCallback(() => {
		rafHandle.current = null;
		const buffer = deltaBuffer.current;
		if (buffer.size === 0) return;
		const entries = Array.from(buffer.values());
		buffer.clear();
		setMessages((prev) => {
			let next = prev;
			for (const { id, chunks } of entries) {
				next = applyChatDelta(next, id, chunks.join(""));
			}
			return next;
		});
	}, []);

	const scheduleFlush = useCallback(() => {
		if (rafHandle.current !== null) return;
		rafHandle.current = window.requestAnimationFrame(flushDeltas);
	}, [flushDeltas]);

	const pushError = useCallback((event: ErrorEvent) => {
		const quantError: QuantError = { ...event, ts: new Date().toISOString() };
		setErrors((prev) => [...prev, quantError].slice(-MAX_ERRORS));
	}, []);

	useEffect(() => {
		let disposed = false;
		let socket: SocketTransport | null = null;
		let retryTimer: number | undefined;
		let attempts = 0;
		let demoTimer: number | undefined;

		const applyHello = (event: HelloEvent) => {
			setProtocol(event.protocol);
			setBackend(event.backend);
			setAgentState(event.agentState);
			setSessionId(event.sessionId);
			setMt5(event.mt5);
			setDemo(event.protocol !== 2);
			if (demoTimer !== undefined) {
				window.clearTimeout(demoTimer);
				demoTimer = undefined;
			}
		};

		const handleEvent = (payload: ServerEvent) => {
			switch (payload.type) {
				case "hello":
					applyHello(payload);
					break;
				case "agent_state":
					setAgentState(payload.state);
					break;
				case "rooms_state":
					setRooms(payload.rooms);
					break;
				case "room_message":
					setRooms((prev) =>
						prev.some((room) => room.id === payload.room) ? prev : [...prev, { id: payload.room, topic: "" }],
					);
					setRoomMessages((prev) => {
						const log = [...(prev[payload.room] ?? []), payload];
						return { ...prev, [payload.room]: log.slice(-MAX_MESSAGES) };
					});
					break;
				case "chat":
					setMessages((prev) => applyChat(prev, payload));
					break;
				case "chat_delta": {
					const entry = deltaBuffer.current.get(payload.id);
					if (entry) {
						entry.chunks.push(payload.delta);
					} else {
						deltaBuffer.current.set(payload.id, { id: payload.id, chunks: [payload.delta] });
					}
					scheduleFlush();
					break;
				}
				case "thinking":
					setThinking((prev) => applyThinking(prev, payload.id, payload.delta, payload.done));
					break;
				case "step":
					setSteps((prev) => ({ ...prev, [payload.id]: payload }));
					break;
				case "subagent":
					setSubagents((prev) => upsertSubagent(prev, payload));
					break;
				case "tearsheet":
					setTearsheetUrl(payload.url);
					setTearsheets((prev) => {
						const filtered = prev.filter((entry) => entry.url !== payload.url);
						const next = [{ url: payload.url, name: payload.name, ts: payload.ts }, ...filtered];
						return next.slice(0, MAX_TEARSHEETS);
					});
					break;
				case "artifact":
					setArtifacts((prev) => ({ ...prev, [payload.kind]: upsertArtifact(prev[payload.kind], payload) }));
					break;
				case "card":
					setCards((prev) => ({ ...prev, [payload.id]: payload }));
					break;
				case "error":
					pushError(payload);
					break;
			}
		};

		const connect = () => {
			setConnection("connecting");
			socket = shouldUseMockSocket() ? createMockSocket() : new WebSocket(wsEndpoint());
			socketRef.current = socket;
			socket.onopen = () => {
				attempts = 0;
				setConnection("open");
				// If no protocol-2 hello arrives within 2s, assume demo backend.
				demoTimer = window.setTimeout(() => {
					if (disposed) return;
					setProtocol((current) => {
						if (current === null) {
							setDemo(true);
							setBackend("demo");
							return 1;
						}
						return current;
					});
				}, DEMO_TIMEOUT_MS);
				void fetchJson<HealthResponse>("/health").then((data) => {
					if (disposed || !data) return;
					if (data.agentState) setAgentState(data.agentState);
				});
				void fetchJson<SubagentsResponse>("/subagents").then((data) => {
					const list = data?.subagents;
					if (disposed || !list) return;
					setSubagents((prev) => list.reduce(upsertSubagent, prev));
				});
				void fetchJson<ArtifactsResponse>("/artifacts?kind=py").then((data) => {
					const list = data?.artifacts;
					if (disposed || !list) return;
					setArtifacts((prev) => ({
						...prev,
						py: list.reduce((acc, event) => upsertArtifact(acc, event), prev.py),
					}));
				});
				void fetchJson<ArtifactsResponse>("/artifacts?kind=mq5").then((data) => {
					const list = data?.artifacts;
					if (disposed || !list) return;
					setArtifacts((prev) => ({
						...prev,
						mq5: list.reduce((acc, event) => upsertArtifact(acc, event), prev.mq5),
					}));
				});
				void fetchJson<ArtifactsResponse>("/artifacts?kind=md").then((data) => {
					const list = data?.artifacts;
					if (disposed || !list) return;
					setArtifacts((prev) => ({
						...prev,
						md: list.reduce((acc, event) => upsertArtifact(acc, event), prev.md),
					}));
				});
				void fetchJson<TearsheetLatestResponse>("/tearsheet/latest").then((data) => {
					if (disposed || !data?.url) return;
					setTearsheetUrl(data.url);
				});
				void fetchJson<TearsheetsResponse>("/tearsheets").then((data) => {
					const list = data?.tearsheets;
					if (disposed || !list) return;
					setTearsheets(list.slice(0, MAX_TEARSHEETS));
				});
				void fetchJson<Mt5Response>("/mt5").then((data) => {
					if (disposed || !data) return;
					setMt5(data);
				});
				void fetchJson<RoomsResponse>("/rooms").then((data) => {
					if (disposed || !data?.rooms) return;
					const list = data.rooms;
					setRooms((prev) => (prev.length > 0 ? prev : list));
					for (const room of list) {
						void fetchJson<RoomMessagesResponse>(`/rooms/${room.id}/messages`).then((history) => {
							if (disposed || !history?.messages) return;
							setRoomMessages((prev) => ({
								...prev,
								[room.id]: history.messages?.slice(-MAX_MESSAGES) ?? [],
							}));
						});
					}
				});
			};

			socket.onmessage = (event) => {
				let payload: unknown;
				try {
					payload = JSON.parse(String(event.data)) as unknown;
				} catch {
					return;
				}
				if (!isServerEvent(payload)) return;
				handleEvent(payload);
			};

			socket.onerror = () => {
				socket?.close();
			};

			socket.onclose = () => {
				if (disposed) return;
				setConnection("closed");
				if (rafHandle.current !== null) {
					window.cancelAnimationFrame(rafHandle.current);
					rafHandle.current = null;
				}
				deltaBuffer.current.clear();
				const delay = Math.min(1000 * 2 ** attempts, 15000);
				attempts += 1;
				retryTimer = window.setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			disposed = true;
			if (retryTimer !== undefined) window.clearTimeout(retryTimer);
			if (demoTimer !== undefined) window.clearTimeout(demoTimer);
			if (rafHandle.current !== null) window.cancelAnimationFrame(rafHandle.current);
			rafHandle.current = null;
			socket?.close();
			socketRef.current = null;
		};
	}, [scheduleFlush, pushError]);

	const send = useCallback((message: ClientMessage) => {
		const socket = socketRef.current;
		if (socket === null || socket.readyState !== SOCKET_OPEN) return;
		socket.send(JSON.stringify(message));
	}, []);

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			setMessages((prev) => [
				...prev,
				{ type: "chat", role: "user", text: trimmed, id: `local-${Date.now()}`, streaming: false },
			]);
			send({ type: "chat", text: trimmed });
		},
		[send],
	);

	const interrupt = useCallback(() => {
		send({ type: "interrupt" });
	}, [send]);

	const refreshMt5 = useCallback(() => {
		send({ type: "refresh_mt5" });
	}, [send]);

	return {
		connection,
		protocol,
		backend,
		agentState,
		mt5,
		sessionId,
		demo,
		messages,
		thinking,
		steps,
		subagents,
		cards,
		tearsheets,
		tearsheetUrl,
		artifacts,
		rooms,
		roomMessages,
		errors,
		sendMessage,
		interrupt,
		refreshMt5,
	};
}
