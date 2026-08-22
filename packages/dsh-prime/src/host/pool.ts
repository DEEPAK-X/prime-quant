import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	type AgentState,
	RpcSession,
	type RpcSessionOptions,
	sniffCard,
	type V2Event,
} from "@earendil-works/pi-web-ui-server";

import type { PrimeTransport } from "../dsh-types.js";

export class PoolBusyError extends Error {
	constructor(message = "Prime Agent is busy; wait for the current turn to finish.") {
		super(message);
		this.name = "PoolBusyError";
	}
}

export interface PrimeRpcPoolOptions {
	/** Workspace cwd for the Prime child (DSH parent session workspace). */
	workspace: string;
	/** Absolute path to packages/coding-agent/dist/bundle/cli.js. */
	cliPath: string;
	execPath?: string;
	sessionDir?: string;
	spawn?: RpcSessionOptions["spawn"];
	commandTimeoutMs?: number;
	log?: (message: string) => void;
}

const DEFAULT_SESSION_DIR = fileURLToPath(new URL("../../.dsh-sessions", import.meta.url));

/**
 * One RpcSession, lazy start, busy lock. Implements PrimeTransport (rpc only).
 */
export class PrimeRpcPool implements PrimeTransport {
	readonly transport: "rpc" = "rpc";
	private session: RpcSession | null = null;
	private ensurePromise: Promise<void> | null = null;
	private readonly workspace: string;
	private readonly cliPath: string;
	private readonly execPath: string;
	private readonly sessionDir: string;
	private readonly spawn: RpcSessionOptions["spawn"];
	private readonly commandTimeoutMs: number | undefined;
	private readonly log: (message: string) => void;
	private stopped = false;

	constructor(options: PrimeRpcPoolOptions) {
		this.workspace = options.workspace;
		this.cliPath = options.cliPath;
		this.execPath = options.execPath ?? process.execPath;
		this.sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
		this.spawn = options.spawn ?? this.bundleSpawn;
		this.commandTimeoutMs = options.commandTimeoutMs;
		this.log = options.log ?? (() => {});
	}

	private bundleSpawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
		void command;
		void args;
		const argv = [this.cliPath, "--mode", "rpc", "--cwd", this.workspace, "--session-dir", this.sessionDir];
		return nodeSpawn(this.execPath, argv, {
			...options,
			cwd: this.workspace,
			windowsHide: true,
			stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
		});
	};

	getAgentState(): AgentState {
		return this.session?.getAgentState() ?? "stopped";
	}

	isBusy(): boolean {
		if (!this.session) return false;
		return this.session.isBusy() || this.session.getAgentState() === "busy";
	}

	subscribe(listener: (event: V2Event) => void): () => void {
		if (!this.session) return () => {};
		return this.session.subscribe(listener);
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.session?.getLastAssistantText();
	}

	async ensure(): Promise<void> {
		if (this.stopped) {
			throw new Error("Prime RPC pool is stopped");
		}
		if (this.session) {
			return;
		}
		if (this.ensurePromise) {
			return this.ensurePromise;
		}
		this.ensurePromise = this.startSession();
		try {
			await this.ensurePromise;
		} finally {
			this.ensurePromise = null;
		}
	}

	private async startSession(): Promise<void> {
		const session = new RpcSession({
			repoRoot: this.workspace,
			execPath: this.execPath,
			sessionDir: this.sessionDir,
			commandTimeoutMs: this.commandTimeoutMs,
			spawn: this.spawn,
			cardSniffer: sniffCard,
			log: this.log,
		});
		this.session = session;
		await session.start();
	}

	async prompt(text: string): Promise<void> {
		if (!this.session) {
			throw new Error("RPC pool is not started");
		}
		if (this.isBusy()) {
			throw new PoolBusyError();
		}
		await this.session.prompt(text);
	}

	async abort(): Promise<void> {
		if (!this.session) return;
		await this.session.interrupt();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const session = this.session;
		this.session = null;
		this.ensurePromise = null;
		if (session) {
			await session.stop();
		}
	}

	/** Wait until the pooled session is no longer busy (turn ended). */
	async waitUntilIdle(): Promise<void> {
		if (!this.session || !this.isBusy()) {
			return;
		}
		const session = this.session;
		await new Promise<void>((resolve) => {
			const unsub = session.subscribe((event) => {
				if (event.type === "agent_state" && event.state !== "busy" && event.state !== "starting") {
					unsub();
					resolve();
				}
			});
			if (!this.isBusy()) {
				unsub();
				resolve();
			}
		});
	}
}
