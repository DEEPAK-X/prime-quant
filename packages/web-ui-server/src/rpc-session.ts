/**
 * BridgeSession implementation over the coding-agent RPC subprocess.
 *
 * Owns the agent lifecycle: spawn (via RpcChildClient), the readiness probe,
 * prompt submission (resending with `streamingBehavior: "followUp"` while a
 * turn is streaming), event translation, and restart-on-exit with capped
 * exponential backoff.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { AgentState, V2Event } from "./events.js";
import { RpcChildClient, type RpcRecord } from "./rpc-client.js";
import { type CardSniffer, EventTranslator } from "./translator.js";

export interface RpcSessionOptions {
	/** Repo root — the agent's cwd and session root. */
	repoRoot: string;
	/** process.execPath override (tests). */
	execPath?: string;
	/** Directory for GUI-isolated agent sessions. */
	sessionDir?: string;
	/** Timeout for a single RPC command response, ms. */
	commandTimeoutMs?: number;
	/** Inject spawn (tests use a fake RPC child). */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Sniff assistant messages for quant JSON cards. */
	cardSniffer?: CardSniffer;
	log?: (message: string) => void;
	/** Timeout for the readiness probe, ms. */
	startTimeoutMs?: number;
	/** Restart-on-exit backoff policy. */
	restart?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
}

export class RpcSession {
	private client: RpcChildClient | null = null;
	private listeners = new Set<(event: V2Event) => void>();
	private readonly translator: EventTranslator;
	private state: AgentState = "starting";
	private streaming = false;
	private lastAssistantText: string | undefined;
	private stopped = false;
	private restartAttempts = 0;
	private restartTimer: NodeJS.Timeout | null = null;
	private userSeq = 0;
	private readonly repoRoot: string;
	private readonly execPath: string | undefined;
	private readonly sessionDir: string | undefined;
	private readonly commandTimeoutMs: number | undefined;
	private readonly spawn: RpcSessionOptions["spawn"];
	private readonly log: (message: string) => void;
	private readonly startTimeoutMs: number;
	private readonly restart: { initialMs: number; maxMs: number; maxAttempts: number };

	constructor(options: RpcSessionOptions) {
		this.repoRoot = options.repoRoot;
		this.execPath = options.execPath;
		this.sessionDir = options.sessionDir;
		this.commandTimeoutMs = options.commandTimeoutMs;
		this.spawn = options.spawn;
		this.log = options.log ?? (() => {});
		this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
		this.restart = {
			initialMs: options.restart?.initialMs ?? 1_000,
			maxMs: options.restart?.maxMs ?? 30_000,
			maxAttempts: options.restart?.maxAttempts ?? 5,
		};
		this.translator = new EventTranslator({ cardSniffer: options.cardSniffer });
	}

	getAgentState(): AgentState {
		return this.state;
	}

	isBusy(): boolean {
		return this.streaming;
	}

	subscribe(listener: (event: V2Event) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.stopped) {
			throw new Error("RpcSession is stopped");
		}
		if (this.client?.isRunning()) {
			return;
		}
		this.setState("starting");
		const client = new RpcChildClient({
			repoRoot: this.repoRoot,
			execPath: this.execPath,
			sessionDir: this.sessionDir,
			commandTimeoutMs: this.commandTimeoutMs,
			spawn: this.spawn,
			log: this.log,
		});
		this.client = client;
		client.onRecord((record) => this.handleRecord(record));
		client.onExit((code, signal) => this.handleExit(code, signal));
		await client.start();
		try {
			// Readiness probe: the first RPC response (get_state) proves the agent
			// accepted our connection and can answer commands. Only then expose
			// agent_state: ready.
			const probe = await client.send({ type: "get_state" });
			if (!probe.success) {
				throw new Error(`Readiness probe failed: ${probe.error ?? "get_state rejected"}`);
			}
			const data = (probe.data ?? {}) as { isStreaming?: unknown };
			this.streaming = data.isStreaming === true;
			this.restartAttempts = 0;
			this.setState("ready");
		} catch (error) {
			// Probe failed (timeout or rejection). If the child already exited,
			// handleExit scheduled the restart; otherwise stop it and do so here.
			const alreadyHandled = this.client === null;
			this.client = null;
			await client.stop().catch(() => {});
			if (!alreadyHandled && !this.stopped) {
				this.handleExit(null, null);
			}
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const client = this.client;
		this.client = null;
		if (client) {
			await client.stop();
		}
		this.setState("stopped");
	}

	async prompt(message: string): Promise<void> {
		const text = message.trim();
		if (!text) {
			return;
		}
		if (!this.client?.isRunning()) {
			throw new Error("RPC agent is not running");
		}
		this.emit({ type: "chat", role: "user", text, id: `u-${++this.userSeq}`, ts: new Date().toISOString() });
		const command: Record<string, unknown> & { type: string } = this.streaming
			? { type: "prompt", message: text, streamingBehavior: "followUp" }
			: { type: "prompt", message: text };
		const response = await this.client.send(command);
		if (!response.success) {
			this.emit({
				type: "error",
				scope: "agent",
				message: response.error ?? "prompt rejected",
				fatal: false,
			});
			throw new Error(response.error ?? "prompt rejected");
		}
	}

	async interrupt(): Promise<void> {
		if (!this.client?.isRunning()) {
			return;
		}
		await this.client.send({ type: "abort" });
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.lastAssistantText;
	}

	private emit(event: V2Event): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	private setState(state: AgentState, detail?: string): void {
		if (this.state === state) {
			return;
		}
		this.state = state;
		this.emit({ type: "agent_state", state, ...(detail ? { detail } : {}) });
	}

	private handleRecord(record: RpcRecord): void {
		const events = this.translator.translate(record);
		for (const event of events) {
			if (event.type === "agent_state") {
				this.streaming = event.state === "busy";
				this.setState(event.state);
			}
			if (event.type === "chat" && event.role === "assistant") {
				this.lastAssistantText = event.text;
			}
			this.emit(event);
		}
	}

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.client = null;
		if (this.stopped) {
			return;
		}
		this.streaming = false;
		if (this.restartAttempts >= this.restart.maxAttempts) {
			this.setState("error", `agent child exited (${signal ?? code}); restart limit reached`);
			return;
		}
		this.setState("error", `agent child exited (${signal ?? code}); restarting`);
		const backoffMs = Math.min(this.restart.initialMs * 2 ** this.restartAttempts, this.restart.maxMs);
		this.restartAttempts += 1;
		this.log(`[rpc] agent exited (${signal ?? code}); restart in ${backoffMs}ms (attempt ${this.restartAttempts})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start().catch((error) => {
				this.log(`[rpc] restart failed: ${String(error)}`);
				this.setState("error", String(error));
			});
		}, backoffMs);
	}
}
