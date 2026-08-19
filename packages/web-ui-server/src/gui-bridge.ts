/**
 * Phase 8A: local HTTP + WebSocket bridge from a Prime Agent interactive
 * session to a web GUI.
 *
 * The bridge runs on `localhost:3001` by default and is deliberately
 * lightweight: it holds a single in-process session (or daemon connection)
 * and exposes three surfaces:
 *
 *   POST /api/chat              stream conversational responses (NDJSON) for a
 *                               user message submitted to the interactive session.
 *   WS   /ws/events             broadcast structured JSON events as the session
 *                               runs (subagent lifecycle, pipeline steps,
 *                               artifact readiness).
 *   GET  /api/artifacts/serve   stream a generated HTML tearsheet / MQL5 script /
 *                               Python artifact from an allowlisted directory.
 *
 * The bridge never blocks the IPython runtime: it subscribes to the session
 * event stream on its own and forwards events to WebSocket clients, while the
 * HTTP request thread drives turns via `prompt`/`promptAndWait` which themselves
 * resolve without holding the kernel.
 *
 * `createV2GuiBridge` implements the GUI v2 contract (docs/gui-wiring/02):
 * WS `/ws` with a `hello` first frame plus REST snapshots, all backed by one
 * in-memory state store fed by the same `emit` path that broadcasts events.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, resolve as pathResolve, relative } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import type { AgentState, Mt5Status, V2Event } from "./events.js";
import { isValidRoomId, type RoomMessage, RoomsRegistry } from "./rooms.js";
import { safeReportName } from "./tearsheets.js";

export const DEFAULT_PORT = 3001;
// Bind IPv4 explicitly: on some hosts `localhost` resolves to ::1 while
// clients resolve it to 127.0.0.1, making connections flaky. The GUI proxies
// to 127.0.0.1:3001, so bind the same address.
export const DEFAULT_HOST = "127.0.0.1";

const WS_OPEN = WebSocket.OPEN;

/** A structured event emitted to WebSocket clients. */
export type BridgeEvent =
	| { type: "SUBAGENT_SPAWNED"; id: string; model_tier: string; task: string }
	| { type: "SUBAGENT_PROGRESS"; id: string; status: string; current_step: string }
	| { type: "SUBAGENT_COMPLETED"; id: string; summary_card: string }
	| {
			type: "PIPELINE_STEP_UPDATE";
			step: "AST_LINT" | "BACKTEST" | "CPCV" | "REPORT";
			status: "PASS" | "FAIL" | "RUNNING";
			details?: string;
	  }
	| {
			type: "ARTIFACT_READY";
			artifactType: "html_tearsheet" | "mq5" | "python";
			file_path: string;
			file_size_kb: number;
	  };

export type BridgeEventType = BridgeEvent["type"];

/** Minimal session surface the bridge needs; decoupled from coding-agent types. */
export interface BridgeSession {
	/** Submit a user message and resolve once it has been accepted. */
	prompt(message: string): Promise<void>;
	/** Subscribe to structured bridge events; returns an unsubscribe function. */
	subscribe(listener: (event: BridgeEvent) => void): () => void;
	/** Last assistant text, for the chat endpoint's final delta. */
	getLastAssistantText(): Promise<string | undefined>;
}

export interface GuiBridgeOptions {
	port?: number;
	host?: string;
	session: BridgeSession;
	/** Root directory artifacts may be served from (path traversal guard). */
	artifactsRoot?: string;
	/** Inject an http server (tests). */
	server?: Server;
}

export interface GuiBridge {
	readonly port: number;
	readonly host: string;
	readonly server: Server;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Emit a structured event to every connected WebSocket client. */
	broadcast(event: BridgeEvent): void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, JSON_HEADERS);
	res.end(JSON.stringify(body));
}

/**
 * Resolve an artifact path against the allowlisted root, rejecting any path
 * that escapes the root (traversal, absolute, or UNC). Returns the safe
 * absolute path or null when the request is rejected.
 */
export function resolveArtifactPath(root: string | undefined, requested: string | undefined): string | null {
	if (!root || !requested) return null;
	// Block absolute and UNC paths outright; only relative subpaths are allowed.
	if (isAbsolute(requested) || requested.startsWith("\\\\")) return null;
	const resolved = pathResolve(root, requested);
	const rel = relative(root, resolved);
	// A path that escapes the root yields a rel starting with `..` (or is absolute
	// on the other drive on Windows). Either way, reject it.
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return resolved;
}

/**
 * Map a raw session event (the coding-agent `AgentConnectionEvent` shape) into
 * the structured bridge events. Exported so tests and the session adapter can
 * share one mapping.
 */
export function mapSessionEvent(raw: {
	type: string;
	event?: { type?: string; child?: Record<string, unknown> } | undefined;
}): BridgeEvent | null {
	if (raw.type !== "session_event") return null;
	const inner = raw.event;
	if (inner?.type !== "rlm_child_update" || !inner.child) return null;
	const child = inner.child;
	const id = String(child.id ?? "");
	const status = String(child.status ?? "");
	const label = String(child.label ?? "");
	const model = String(child.model ?? "");
	const preview = String(child.answerPreview ?? "");
	// Tier selectors arrive as `tier:worker` or resolved `provider/model`; emit the
	// bare tier/model identifier either way.
	const modelTier = model.startsWith("tier:")
		? model.slice("tier:".length)
		: model.includes("/")
			? (model.split("/")[1] ?? model)
			: model;
	if (status === "running") {
		return {
			type: "SUBAGENT_SPAWNED",
			id,
			model_tier: modelTier,
			task: label,
		};
	}
	if (status === "done" || status === "error") {
		return { type: "SUBAGENT_COMPLETED", id, summary_card: preview };
	}
	return { type: "SUBAGENT_PROGRESS", id, status, current_step: label };
}

export function createGuiBridge(options: GuiBridgeOptions): GuiBridge {
	const port = options.port ?? DEFAULT_PORT;
	const host = options.host ?? DEFAULT_HOST;
	const server = options.server ?? createServer();
	const wss = new WebSocketServer({ noServer: true });
	const clients = new Set<WebSocket>();
	const session = options.session;

	server.on("upgrade", (req, socket, head) => {
		if (req.url === "/ws/events") {
			wss.handleUpgrade(req, socket, head, (ws) => {
				clients.add(ws);
				ws.on("close", () => clients.delete(ws));
			});
		} else {
			socket.destroy();
		}
	});

	// Forward every structured session event to connected clients.
	session.subscribe((event) => {
		const text = JSON.stringify(event);
		for (const client of clients) {
			if (client.readyState === WS_OPEN) client.send(text);
		}
	});

	server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${host}`);
		const path = url.pathname;

		if (req.method === "GET" && path === "/api/health") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		if (req.method === "POST" && path === "/api/chat") {
			const body = await readBody(req);
			let message: string;
			try {
				const parsed = body ? (JSON.parse(body) as { message?: string }) : undefined;
				message = parsed?.message ?? "";
			} catch {
				sendJson(res, 400, { error: "invalid JSON body" });
				return;
			}
			if (!message.trim()) {
				sendJson(res, 400, { error: "message is required" });
				return;
			}
			res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
			res.write(`${JSON.stringify({ type: "turn_start", message })}\n`);
			try {
				await session.prompt(message);
			} catch (error) {
				res.write(`${JSON.stringify({ type: "turn_error", error: String(error) })}\n`);
				res.end();
				return;
			}
			const finalText = (await session.getLastAssistantText()) ?? "";
			res.write(`${JSON.stringify({ type: "assistant_text", text: finalText })}\n`);
			res.write(`${JSON.stringify({ type: "turn_end" })}\n`);
			res.end();
			return;
		}

		if (req.method === "GET" && path === "/api/artifacts/serve") {
			const requested = url.searchParams.get("path") ?? undefined;
			const resolved = resolveArtifactPath(options.artifactsRoot, requested);
			if (!resolved) {
				sendJson(res, 400, { error: "path is outside the allowlisted artifacts root" });
				return;
			}
			let stats: ReturnType<typeof statSync> | undefined;
			try {
				stats = statSync(resolved);
			} catch {
				sendJson(res, 404, { error: "artifact not found" });
				return;
			}
			if (!stats.isFile()) {
				sendJson(res, 404, { error: "not a file" });
				return;
			}
			res.writeHead(200, {
				"content-type": mimeFor(resolved),
				"content-length": stats.size,
				"cache-control": "no-store",
			});
			createReadStream(resolved).pipe(res);
			return;
		}

		sendJson(res, 404, { error: "not found" });
	});

	return {
		port,
		host,
		server,
		start() {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
		},
		async stop() {
			for (const client of clients) client.close();
			clients.clear();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		broadcast(event) {
			const text = JSON.stringify(event);
			for (const client of clients) {
				if (client.readyState === WS_OPEN) client.send(text);
			}
		},
	};
}

function mimeFor(path: string): string {
	if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html; charset=utf-8";
	if (path.endsWith(".mq5") || path.endsWith(".mqh")) return "text/plain; charset=utf-8";
	if (path.endsWith(".py")) return "text/x-python; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	return "application/octet-stream";
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) reject(new Error("body too large"));
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// GUI v2 contract surface (docs/gui-wiring/02-api-contract.md)
// ---------------------------------------------------------------------------

export interface V2BridgeSession {
	prompt(message: string): Promise<void>;
	interrupt(): Promise<void>;
	getAgentState(): AgentState;
}

export interface V2BridgeMt5 {
	/** Cached MT5 status; probes only when stale (see mt5.ts). */
	getStatus(): Promise<Mt5Status>;
	/** Force a fresh probe (WS `refresh_mt5`). */
	refresh(): Promise<Mt5Status>;
}

export interface V2GuiBridgeOptions {
	port?: number;
	host?: string;
	/** Inject an http server (tests). */
	server?: Server;
	session: V2BridgeSession;
	mt5: V2BridgeMt5;
	sessionId: string | null;
	/** Repo root — `/reports/` files are served from here (traversal-safe). */
	artifactsRoot: string;
	/** A2 rooms registry (defaults to the PLAN.md room set). */
	rooms?: RoomsRegistry;
	log?: (message: string) => void;
}

export interface V2GuiBridge {
	readonly port: number;
	readonly host: string;
	readonly server: Server;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Feed a v2 event into the state store and broadcast it to `/ws` clients. */
	emit(event: V2Event): void;
	/** Current agent state, for the `hello` frame and `/api/health`. */
	getAgentState(): AgentState;
}

/**
 * v2 bridge: WS `/ws` (hello first frame + broadcast + client chat/interrupt/
 * refresh_mt5) and the REST snapshot endpoints, backed by one in-memory store
 * fed by `emit` — the single source of truth for both WS push and REST reads.
 * Binds `127.0.0.1` explicitly (never `0.0.0.0`).
 */
export function createV2GuiBridge(options: V2GuiBridgeOptions): V2GuiBridge {
	const port = options.port ?? DEFAULT_PORT;
	const host = options.host ?? DEFAULT_HOST;
	const server = options.server ?? createServer();
	const wss = new WebSocketServer({ noServer: true });
	// Per-client room subscriptions (A2). Absent/null means "all rooms" so
	// older clients that never send `subscribe` receive every room_message.
	const subscriptions = new Map<WebSocket, Set<string> | null>();
	const clients = new Set<WebSocket>();
	const log = options.log ?? (() => {});
	const rooms = options.rooms ?? new RoomsRegistry();

	const store = {
		agentState: "starting" as AgentState,
		subagents: new Map<string, Extract<V2Event, { type: "subagent" }>>(),
		artifacts: new Map<string, Extract<V2Event, { type: "artifact" }>>(),
		tearsheets: new Map<string, Extract<V2Event, { type: "tearsheet" }>>(),
	};

	const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
		res.writeHead(status, JSON_HEADERS);
		res.end(JSON.stringify(body));
	};

	const sortedTearsheets = () => [...store.tearsheets.values()].sort((a, b) => ((a.ts ?? "") < (b.ts ?? "") ? 1 : -1));

	const applyEvent = (event: V2Event): void => {
		switch (event.type) {
			case "agent_state":
				store.agentState = event.state;
				break;
			case "subagent":
				store.subagents.set(event.id, event);
				break;
			case "artifact":
				store.artifacts.set(`${event.kind}:${event.name}`, event);
				break;
			case "tearsheet": {
				const key = event.name ?? event.url;
				const isNew = !store.tearsheets.has(key);
				store.tearsheets.set(key, event);
				if (isNew) {
					const label = event.name || event.url;
					postRoomMessage("research", "pipeline", `Tearsheet generated: [${label}](${event.url})`);
				}
				break;
			}
			default:
				break;
		}
	};

	const acceptsRoom = (ws: WebSocket, room: string): boolean => {
		const sub = subscriptions.get(ws);
		return sub === undefined || sub === null || sub.has(room);
	};

	const emit = (event: V2Event): void => {
		applyEvent(event);
		const text = JSON.stringify(event);
		const room = event.type === "room_message" ? event.room : null;
		for (const client of clients) {
			if (client.readyState === WS_OPEN && (room === null || acceptsRoom(client, room))) client.send(text);
		}
	};

	/** Watcher intake: store + broadcast a room message. */
	const postRoomMessage = (room: string, from: string, text: string): RoomMessage | null => {
		const message = rooms.post(room, from, text);
		if (message) {
			emit({ type: "room_message", ...message });
		}
		return message;
	};

	const sendHello = (ws: WebSocket, mt5: Mt5Status): void => {
		ws.send(
			JSON.stringify({
				type: "hello",
				protocol: 2,
				backend: "bridge",
				agentState: store.agentState,
				sessionId: options.sessionId,
				mt5,
				rooms: rooms.list().map((room) => room.id),
			} satisfies V2Event),
		);
		ws.send(JSON.stringify({ type: "rooms_state", rooms: rooms.list() } satisfies V2Event));
	};

	server.on("upgrade", (req, socket, head) => {
		if (req.url === "/ws") {
			wss.handleUpgrade(req, socket, head, (ws) => {
				clients.add(ws);
				ws.on("close", () => {
					clients.delete(ws);
					subscriptions.delete(ws);
				});
				// First frame is always `hello` (contract §1.1); probe MT5 once.
				void options.mt5
					.getStatus()
					.then((status) => {
						if (ws.readyState === WS_OPEN) sendHello(ws, status);
					})
					.catch((error) => {
						log(`[bridge] mt5 hello probe failed: ${String(error)}`);
						if (ws.readyState === WS_OPEN) {
							sendHello(ws, { status: "unknown", detail: null, checkedAt: null });
						}
					});
				// Client -> server: chat / interrupt / refresh_mt5 (contract §2).
				ws.on("message", (raw) => {
					let payload: unknown;
					try {
						const text = Buffer.isBuffer(raw)
							? raw.toString()
							: Array.isArray(raw)
								? Buffer.concat(raw).toString()
								: Buffer.from(raw).toString();
						payload = JSON.parse(text) as unknown;
					} catch {
						return;
					}
					if (typeof payload !== "object" || payload === null) return;
					const record = payload as Record<string, unknown>;
					switch (record.type) {
						case "chat": {
							const text = typeof record.text === "string" ? record.text.trim() : "";
							if (!text) return;
							void options.session.prompt(text).catch((error) => {
								log(`[bridge] prompt failed: ${String(error)}`);
								emit({ type: "error", scope: "bridge", message: String(error), fatal: false });
							});
							break;
						}
						case "interrupt":
							void options.session.interrupt().catch((error) => {
								log(`[bridge] interrupt failed: ${String(error)}`);
							});
							break;
						case "refresh_mt5":
							void options.mt5
								.refresh()
								.then((status) => {
									if (ws.readyState === WS_OPEN) sendHello(ws, status);
								})
								.catch((error) => {
									log(`[bridge] mt5 refresh failed: ${String(error)}`);
								});
							break;
						case "subscribe": {
							// A2 rooms: narrow this client's room_message feed. `null`
							// (or a missing rooms field) restores the all-rooms default.
							if (record.rooms === null || record.rooms === undefined) {
								subscriptions.set(ws, null);
							} else if (Array.isArray(record.rooms)) {
								const ids = record.rooms.filter(
									(id): id is string => typeof id === "string" && isValidRoomId(id),
								);
								subscriptions.set(ws, new Set(ids));
							}
							break;
						}
						default:
							break;
					}
				});
			});
		} else {
			socket.destroy();
		}
	});

	server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${host}`);
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (path === "/api/health") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			sendJson(res, 200, { ok: true, backend: "bridge", agentState: store.agentState });
			return;
		}

		if (path === "/api/subagents") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			sendJson(res, 200, { subagents: [...store.subagents.values()] });
			return;
		}

		if (path === "/api/artifacts") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			const kind = url.searchParams.get("kind");
			if (kind !== null && kind !== "py" && kind !== "mq5" && kind !== "md") {
				sendJson(res, 400, { error: "invalid kind" });
				return;
			}
			const artifacts = [...store.artifacts.values()].filter((event) => kind === null || event.kind === kind);
			sendJson(res, 200, { artifacts });
			return;
		}

		if (path === "/api/tearsheet/latest") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			const latest = sortedTearsheets()[0];
			if (!latest) {
				res.writeHead(204);
				res.end();
				return;
			}
			sendJson(res, 200, { url: latest.url, name: latest.name, ts: latest.ts });
			return;
		}

		if (path === "/api/tearsheets") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			sendJson(res, 200, { tearsheets: sortedTearsheets() });
			return;
		}

		if (path === "/api/mt5") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			try {
				sendJson(res, 200, await options.mt5.getStatus());
			} catch (error) {
				log(`[bridge] mt5 probe failed: ${String(error)}`);
				sendJson(res, 200, { status: "unknown", detail: null, checkedAt: null });
			}
			return;
		}

		// A2 rooms: list, per-room history, and watcher intake.
		if (path === "/api/rooms") {
			if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			sendJson(res, 200, {
				rooms: rooms.list().map((room) => ({ ...room, messages: rooms.history(room.id).length })),
			});
			return;
		}

		const roomMatch = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,31})\/messages?$/.exec(path);
		if (roomMatch) {
			const roomId = roomMatch[1];
			if (method === "GET") {
				if (!rooms.has(roomId)) return sendJson(res, 404, { error: "unknown room" });
				sendJson(res, 200, { room: roomId, messages: rooms.history(roomId) });
				return;
			}
			if (method === "POST") {
				let parsed: { from?: unknown; text?: unknown } | undefined;
				try {
					parsed = JSON.parse(await readBody(req)) as { from?: unknown; text?: unknown };
				} catch {
					return sendJson(res, 400, { error: "invalid JSON body" });
				}
				const message =
					typeof parsed?.from === "string" && typeof parsed?.text === "string"
						? postRoomMessage(roomId, parsed.from, parsed.text)
						: null;
				if (!message) return sendJson(res, 400, { error: "from and text are required" });
				sendJson(res, 201, { message });
				return;
			}
			return sendJson(res, 405, { error: "method not allowed" });
		}

		if (method === "GET" && path.startsWith("/reports/")) {
			const encoded = path.slice("/reports/".length);
			let decoded: string;
			try {
				decoded = decodeURIComponent(encoded);
			} catch {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			const name = safeReportName(decoded);
			const resolved = name ? resolveArtifactPath(options.artifactsRoot, name) : null;
			if (!resolved) {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			let stats: ReturnType<typeof statSync> | undefined;
			try {
				stats = statSync(resolved);
			} catch {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			if (!stats.isFile()) {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": stats.size,
				"cache-control": "no-store",
			});
			createReadStream(resolved).pipe(res);
			return;
		}

		if (method === "GET" && path === "/api/artifacts/serve") {
			const requested = url.searchParams.get("path") ?? undefined;
			const resolved = resolveArtifactPath(options.artifactsRoot, requested);
			if (!resolved) {
				sendJson(res, 400, { error: "path is outside the allowlisted artifacts root" });
				return;
			}
			let stats: ReturnType<typeof statSync> | undefined;
			try {
				stats = statSync(resolved);
			} catch {
				sendJson(res, 404, { error: "artifact not found" });
				return;
			}
			if (!stats.isFile()) {
				sendJson(res, 404, { error: "not a file" });
				return;
			}
			res.writeHead(200, {
				"content-type": mimeFor(resolved),
				"content-length": stats.size,
				"cache-control": "no-store",
			});
			createReadStream(resolved).pipe(res);
			return;
		}

		// WebSocket is the source of truth; unknown REST paths 404 without crashing.
		sendJson(res, 404, { error: "not found" });
	});

	return {
		port,
		host,
		server,
		start() {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
		},
		async stop() {
			for (const client of clients) client.close();
			clients.clear();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		emit,
		getAgentState() {
			return store.agentState;
		},
	};
}
