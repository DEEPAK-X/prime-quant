/**
 * JSONL child-process client for the coding-agent RPC protocol
 * (packages/coding-agent/docs/rpc.md).
 *
 * Responsibilities:
 *   - spawn the agent in RPC mode (Windows-safe: process.execPath + tsx CLI,
 *     never `npx` which is a .cmd shim on win32),
 *   - read stdout with a strict LF-only JSONL reader (Node `readline` is
 *     forbidden: it splits on U+2028/U+2029 which are valid inside JSON
 *     strings),
 *   - correlate command responses by `id` and fan out every other record.
 *
 * This is pure transport — no event translation happens here.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

export interface RpcResponseRecord extends RpcRecord {
	type: "response";
	id?: string;
	success: boolean;
	command?: string;
	error?: string;
	data?: unknown;
}

export interface RpcChildClientOptions {
	/** Repo root — the child's cwd and the base for resolving the CLI entry. */
	repoRoot: string;
	/** process.execPath override (tests). Defaults to process.execPath. */
	execPath?: string;
	/** Directory for GUI-isolated agent sessions (defaults to `.gui-sessions`). */
	sessionDir?: string;
	/** Timeout for a single command's response, ms. */
	commandTimeoutMs?: number;
	/** Inject spawn (tests use a fake RPC child). The client always passes all three args. */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	log?: (message: string) => void;
}

/** Resolve the tsx CLI entry through node's module lookup (hoisted monorepo deps). */
function resolveTsxCli(): string {
	const require = createRequire(import.meta.url);
	return path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
}

/**
 * Attach a strict LF-only JSONL reader to a stream.
 *
 * Hand-buffers string chunks, splits on `\n` only, strips one trailing `\r`,
 * and never uses Node `readline` (which would split on U+2028/U+2029).
 * Returns an unsubscribe function.
 */
export function attachJsonlLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	// Segments of the current not-yet-terminated line. We never concatenate into
	// one growing buffer: each chunk is scanned once with an offset-advancing
	// indexOf and the segments are joined exactly once, when the newline lands.
	let pending: string[] = [];

	const emitLine = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);

	const flush = () => {
		if (pending.length > 0) {
			emitLine(pending.join(""));
			pending = [];
		}
	};

	const onData = (chunk: string | Buffer) => {
		const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let start = 0;
		let newlineIndex = text.indexOf("\n");
		while (newlineIndex !== -1) {
			const segment = text.slice(start, newlineIndex);
			if (pending.length > 0) {
				pending.push(segment);
				emitLine(pending.join(""));
				pending = [];
			} else {
				emitLine(segment);
			}
			start = newlineIndex + 1;
			newlineIndex = text.indexOf("\n", start);
		}
		if (start < text.length) {
			pending.push(text.slice(start));
		}
	};

	const onEnd = () => {
		const tail = decoder.end();
		if (tail.length > 0) {
			pending.push(tail);
		}
		flush();
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

export class RpcChildClient {
	private process: ChildProcess | null = null;
	private stopReader: (() => void) | null = null;
	private listeners = new Set<(record: RpcRecord) => void>();
	private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
	private pending = new Map<
		string,
		{ resolve: (response: RpcResponseRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private requestSeq = 0;
	private stderrTail = "";
	private readonly repoRoot: string;
	private readonly execPath: string;
	private readonly sessionDir: string;
	private readonly commandTimeoutMs: number;
	private readonly spawnFn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	private readonly log: (message: string) => void;

	constructor(options: RpcChildClientOptions) {
		this.repoRoot = options.repoRoot;
		this.execPath = options.execPath ?? process.execPath;
		this.sessionDir = options.sessionDir ?? path.join(options.repoRoot, "packages", "web-ui-server", ".gui-sessions");
		this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
		this.spawnFn = options.spawn ?? nodeSpawn;
		this.log = options.log ?? (() => {});
	}

	get childPid(): number | undefined {
		return this.process?.pid;
	}

	isRunning(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	onRecord(listener: (record: RpcRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("RPC child already started");
		}
		// The GUI session dir is an isolation nicety, not a hard requirement:
		// if the repo root is read-only (e.g. a sandbox), spawn the agent
		// without --session-dir and let it use its default session location.
		let sessionDir: string | null = null;
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			sessionDir = this.sessionDir;
		} catch (error) {
			this.log(`[rpc] could not create session dir ${this.sessionDir}: ${(error as Error).message}`);
		}
		const tsxCli = resolveTsxCli();
		const cliEntry = path.join(this.repoRoot, "packages", "coding-agent", "src", "cli.ts");
		const args = [tsxCli, cliEntry, "--mode", "rpc", "--cwd", this.repoRoot];
		if (sessionDir) args.push("--session-dir", sessionDir);
		this.log(`[rpc] spawn ${this.execPath} ${args.join(" ")}`);
		this.process = this.spawnFn(this.execPath, args, {
			cwd: this.repoRoot,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		} satisfies SpawnOptions);
		const child = this.process;

		child.stderr?.on("data", (data: Buffer) => {
			this.stderrTail = `${this.stderrTail}${data.toString()}`.slice(-16_384);
		});

		this.stopReader = attachJsonlLineReader(child.stdout!, (line) => {
			let record: RpcRecord;
			try {
				record = JSON.parse(line) as RpcRecord;
			} catch {
				this.log(`[rpc] ignoring unparseable line: ${line.slice(0, 200)}`);
				return;
			}
			this.handleRecord(record);
		});

		child.on("error", (error) => {
			this.log(`[rpc] child error: ${error.message}`);
		});

		child.on("exit", (code, signal) => {
			this.stopReader?.();
			this.stopReader = null;
			this.process = null;
			for (const request of [...this.pending.values()]) {
				clearTimeout(request.timer);
				request.reject(new Error(`RPC child exited (${signal ?? code})`));
			}
			this.pending.clear();
			for (const listener of [...this.exitListeners]) {
				listener(code, signal);
			}
		});
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) {
			return;
		}
		this.stopReader?.();
		this.stopReader = null;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async send(command: Record<string, unknown> & { type: string }): Promise<RpcResponseRecord> {
		const child = this.process;
		if (!child?.stdin) {
			throw new Error("RPC child not running");
		}
		const id = `req_${++this.requestSeq}`;
		const line = `${JSON.stringify({ ...command, id })}\n`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderrTail}`));
			}, this.commandTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				child.stdin!.write(line);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleRecord(record: RpcRecord): void {
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const request = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			clearTimeout(request.timer);
			request.resolve(record as RpcResponseRecord);
			return;
		}
		for (const listener of [...this.listeners]) {
			listener(record);
		}
	}
}
