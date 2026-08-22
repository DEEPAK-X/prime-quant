/**
 * Cordis entry bridging the pinned DSH host services to the plugin's
 * duck-typed internals (docs/dsh-adapter/02 section 3 rows
 * `subagent-prime-rpc` / `prime-host-glue`; integration-phase shim owned by
 * Agent C — the wrapped modules under src/host stay Agent A's).
 *
 * Adaptations against the pinned 0.1.1-rc.2 host:
 * - `subagents.registerProvider({ name, inheritsParentContext, capabilities, start })`
 *   with the run contract `{ result: Promise<{ output: blocks, stopReason }>, dispose }`.
 * - `systemPrompt.section({ name, order, text })`.
 * - `webServer.register({ kind: "exact" | "prefix", path, handler })` with raw
 *   node `(req, res)` handlers; this module serves `/prime-reports/*` files
 *   itself (traversal-guarded by resolvePrimeReport) because the inner glue's
 *   express-style JSON responder is not wired to node http.
 * - Session mirroring (`prime/*` chat events) is deferred until the session
 *   seam is agreed in dsh-contract; delegation results still return as text.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import process from "node:process";

import { createPrimeGlue, PRIME_PROMPT_SECTION, PRIME_PROMPT_SECTION_ID } from "./host/glue.js";
import { PrimeRpcPool, PrimeRpcProvider } from "./host/index.js";
import { MISSING_CLI_ERROR, resolvePrimeCli } from "./resolve-cli.js";

export const name = "prime-quant-host";

/** Service keys provided by the pinned web profile (verified against rc.2). */
export const inject = ["subagents", "systemPrompt", "webServer"] as const;

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".csv": "text/csv; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

function serveJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function serveFile(res: ServerResponse, filePath: string): void {
	const stat = statSync(filePath);
	res.writeHead(200, {
		"content-type": MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream",
		"content-length": String(stat.size),
	});
	createReadStream(filePath).pipe(res);
}

/**
 * Wrap the plugin's express-style `(req, res)` handlers onto raw node http.
 * The wrapper exposes only what the inner glue uses: `status()` chaining plus
 * `json()` / `type()` / `send()` / `end()`.
 */
export function expressify(handler: (req: IncomingMessage, res: never) => void | Promise<void>): RouteHandler {
	return async (req, res) => {
		let status = 200;
		let contentType: string | undefined;
		const wrapped = {
			status(code: number) {
				status = code;
				return wrapped;
			},
			type(value: string) {
				contentType = value;
				return wrapped;
			},
			json(body: unknown) {
				res.writeHead(status, { "content-type": contentType ?? "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			},
			send(body: string | Uint8Array) {
				res.writeHead(status, { "content-type": contentType ?? "text/plain; charset=utf-8" });
				res.end(body);
			},
			end() {
				res.writeHead(status);
				res.end();
			},
		};
		await handler(req, wrapped as never);
	};
}

interface SubagentStartRequest {
	prompt?: unknown;
	signal?: AbortSignal;
}

interface SubagentStartResult {
	result: Promise<{ output: unknown; stopReason: string }>;
	dispose(): Promise<void>;
}

/**
 * Build the plugin's duck-typed HostContext view over a pinned Cordis
 * context, then run Agent A's `apply`. Exported for tests.
 */
export function apply(ctx: {
	subagents: {
		registerProvider(provider: {
			name: string;
			inheritsParentContext: boolean;
			capabilities: Record<string, boolean>;
			start(request: SubagentStartRequest): Promise<SubagentStartResult>;
		}): () => void;
	};
	systemPrompt: {
		section(section: { name: string; order: number; text: string }): () => void;
	};
	webServer: {
		register(route: { kind: "exact" | "prefix"; path: string; handler: RouteHandler }): () => void;
	};
	effect(setup: () => () => void): unknown;
}): { dispose(): Promise<void> } {
	const cliPath = resolvePrimeCli();
	if (!cliPath) {
		throw new Error(`${MISSING_CLI_ERROR} The DSH surface stays up; fix the checkout and retry subagent_prime.`);
	}
	const workspace = process.cwd();
	const pool = new PrimeRpcPool({ workspace, cliPath });
	const provider = new PrimeRpcProvider({ pool, cliPath });

	ctx.subagents.registerProvider({
		name: "prime",
		inheritsParentContext: false,
		capabilities: {},
		async start(request) {
			const text = typeof request.prompt === "string" ? request.prompt : "";
			const run = await provider.start({ text });
			const onAbort = () => {
				void run.dispose();
			};
			if (request.signal) {
				if (request.signal.aborted) onAbort();
				else request.signal.addEventListener("abort", onAbort, { once: true });
			}
			return {
				result: run.result.then((settled) => ({
					output: settled.output ? [{ type: "text", text: settled.output }] : [],
					stopReason: settled.stopReason,
				})),
				async dispose() {
					request.signal?.removeEventListener("abort", onAbort);
					await run.dispose();
				},
			};
		},
	});

	ctx.systemPrompt.section({
		name: PRIME_PROMPT_SECTION_ID,
		order: -10,
		text: PRIME_PROMPT_SECTION,
	});

	const glue = createPrimeGlue({ cliPath, pool, artifactsRoot: workspace });
	ctx.webServer.register({
		kind: "prefix",
		path: "/prime-reports",
		handler: async (req, res) => {
			const requested = decodeURIComponent(((req.url ?? "").split("?")[0] ?? "").replace(/^\/prime-reports\/?/, ""));
			const resolved = glue.resolvePrimeReport(requested);
			if (!resolved.ok && resolved.reason === "rejected") {
				serveJson(res, 400, { error: "path is outside the allowlisted artifacts root" });
				return;
			}
			if (!resolved.ok || !existsSync(resolved.path) || !statSync(resolved.path).isFile()) {
				serveJson(res, 404, { error: "artifact not found" });
				return;
			}
			serveFile(res, resolved.path);
		},
	});
	ctx.webServer.register({
		kind: "exact",
		path: "/prime-status",
		handler: async (_req, res) => {
			serveJson(res, 200, await glue.getStatus());
		},
	});

	let disposed = false;
	ctx.effect(() => {
		return () => {
			disposed = true;
			void pool.stop();
		};
	});

	return {
		async dispose() {
			if (!disposed) {
				await pool.stop();
				disposed = true;
			}
		},
	};
}
