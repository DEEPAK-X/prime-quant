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
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, resolve as pathResolve, relative } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_PORT = 3001;
export const DEFAULT_HOST = "localhost";

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
