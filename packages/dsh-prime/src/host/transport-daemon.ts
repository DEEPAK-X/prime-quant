/**
 * Pattern 3 daemon transport (docs/dsh-adapter/02 §8, docs/dsh-adapter/05 C4).
 *
 * Implements the PrimeTransport interface from ../dsh-types.js against an
 * already-running TUI-owned Prime Agent daemon, using existing protocol
 * commands only: `create` + `attach` for a dedicated client-owned session,
 * `prompt` / `abort` to drive it, `session_event` broadcasts for output, and
 * `detach` on stop. It never sends `shutdown` — the TUI still owns the daemon.
 *
 * Attach fails closed: a daemon on a different protocol version or without
 * the negotiated `client_owned_sessions` capability makes every async entry
 * point throw, so the caller keeps its RPC pool fallback. DSH apply() must
 * never call this; only the first start() may try the daemon and log one
 * line before falling back.
 */
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonClient,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	defaultDaemonSocketPath,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentState,
	EventTranslator,
	type RpcRecord,
	sniffCard,
	type V2Event,
} from "@earendil-works/pi-web-ui-server";

import type { PrimeTransport } from "../dsh-types.js";

export const PRIME_DAEMON_SESSION_NAME = "dsh-prime";

const REQUIRED_DAEMON_CAPABILITY = "client_owned_sessions" as const;

/** AgentEvent-family record types the v2 EventTranslator consumes; other session events are ignored. */
const TRANSLATED_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

/**
 * Structural slice of the real DaemonClient used here. The production factory
 * passes a real client; tests inject a scripted double. No protocol types are
 * copied — commands and responses stay the public wire types.
 */
export interface PrimeDaemonTransportClient {
	connect(timeoutMs?: number): Promise<void>;
	waitForHello(timeoutMs?: number): Promise<{ protocol: { version: number }; serverCapabilities?: readonly string[] }>;
	request(command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	onMessage(listener: (message: DaemonOutbound) => void): () => void;
	close(): void;
}

export interface PrimeDaemonTransportOptions {
	/** Workspace cwd handed to the created daemon session (DSH parent workspace). */
	workspace: string;
	/** Daemon socket override (default: defaultDaemonSocketPath(), like the TUI). */
	socketPath?: string;
	/** Session name recorded in the daemon (default: "dsh-prime"). */
	sessionName?: string;
	connectTimeoutMs?: number;
	helloTimeoutMs?: number;
	/** Client factory (tests inject a double; default spawns a real DaemonClient). */
	clientFactory?: (socketPath: string) => PrimeDaemonTransportClient;
	log?: (message: string) => void;
}

interface AttachFailure extends Error {
	attachFailed: true;
}

function attachFailure(message: string): AttachFailure {
	const error = new Error(`Prime daemon transport unavailable: ${message}`) as AttachFailure;
	error.attachFailed = true;
	return error;
}

export function isAttachFailure(error: unknown): error is AttachFailure {
	return typeof error === "object" && error !== null && (error as { attachFailed?: unknown }).attachFailed === true;
}

/**
 * Daemon-backed PrimeTransport. One dedicated client-owned session per
 * transport instance; prompts run sequentially through the daemon's own busy
 * handling (`isBusy()` reflects agent_start / agent_end).
 */
export class PrimeDaemonTransport implements PrimeTransport {
	private client: PrimeDaemonTransportClient | null = null;
	private sessionId: string | null = null;
	private ensurePromise: Promise<void> | null = null;
	private readonly translator = new EventTranslator({ cardSniffer: sniffCard });
	private readonly listeners = new Set<(event: V2Event) => void>();
	private state: AgentState = "starting";
	private streaming = false;
	private lastAssistantText: string | undefined;
	private stopped = false;
	private readonly options: PrimeDaemonTransportOptions;

	constructor(options: PrimeDaemonTransportOptions) {
		this.options = options;
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

	async getLastAssistantText(): Promise<string | undefined> {
		return this.lastAssistantText;
	}

	async ensure(): Promise<void> {
		if (this.stopped) {
			throw new Error("Prime daemon transport is stopped");
		}
		if (this.sessionId) {
			return;
		}
		if (!this.ensurePromise) {
			this.ensurePromise = this.attach().finally(() => {
				this.ensurePromise = null;
			});
		}
		await this.ensurePromise;
	}

	async prompt(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		await this.ensure();
		await this.requestOrThrow({
			type: "prompt",
			activeSessionId: this.requiredSessionId(),
			message: trimmed,
		});
	}

	async abort(): Promise<void> {
		if (!this.sessionId || !this.client) {
			return;
		}
		try {
			await this.client.request({ type: "abort", activeSessionId: this.sessionId });
		} catch (error) {
			this.log(`daemon abort failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Detach and drop the connection. Never sends `shutdown`: the TUI owns the
	 * daemon, and the client-owned session is the daemon's to reap once its
	 * owning client disconnects.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		this.streaming = false;
		const client = this.client;
		const sessionId = this.sessionId;
		this.client = null;
		this.sessionId = null;
		if (client) {
			try {
				if (sessionId) {
					await client.request({ type: "detach", activeSessionId: sessionId });
				}
			} catch {
				// Detach is best-effort; closing the socket ends ownership anyway.
			}
			client.close();
		}
		this.setState("stopped");
	}

	private requiredSessionId(): string {
		if (!this.sessionId) {
			throw new Error("Prime daemon transport is not attached");
		}
		return this.sessionId;
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private setState(state: AgentState, detail?: string): void {
		if (this.state === state && !detail) {
			return;
		}
		this.state = state;
		this.emit({ type: "agent_state", state, ...(detail ? { detail } : {}) });
	}

	private emit(event: V2Event): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	private requestOrThrow(command: DaemonCommand): Promise<DaemonResponse> {
		const client = this.client;
		if (!client) {
			return Promise.reject(new Error("Prime daemon transport is not connected"));
		}
		return client.request(command);
	}

	private attach(): Promise<void> {
		const socketPath = this.options.socketPath ?? defaultDaemonSocketPath();
		const client = (this.options.clientFactory ?? ((path: string) => new DaemonClient(path)))(socketPath);
		this.client = client;
		client.onMessage((message) => this.handleMessage(message));
		return this.attachSession(client, socketPath).catch((error: unknown) => {
			this.client = null;
			this.sessionId = null;
			try {
				client.close();
			} catch {
				// Closing a half-open client must not mask the attach failure.
			}
			this.setState("error", error instanceof Error ? error.message : String(error));
			throw error;
		});
	}

	private async attachSession(client: PrimeDaemonTransportClient, socketPath: string): Promise<void> {
		const connectTimeoutMs = this.options.connectTimeoutMs ?? 2000;
		const helloTimeoutMs = this.options.helloTimeoutMs ?? 2000;
		try {
			await client.connect(connectTimeoutMs);
		} catch (error) {
			throw attachFailure(
				`connect failed on ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let hello: Awaited<ReturnType<PrimeDaemonTransportClient["waitForHello"]>>;
		try {
			hello = await client.waitForHello(helloTimeoutMs);
		} catch (error) {
			throw attachFailure(
				`handshake failed on ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (hello.protocol.version !== DAEMON_PROTOCOL_VERSION) {
			throw attachFailure(`daemon protocol v${hello.protocol.version} != client v${DAEMON_PROTOCOL_VERSION}`);
		}
		if (!hello.serverCapabilities?.includes(REQUIRED_DAEMON_CAPABILITY)) {
			throw attachFailure(`daemon lacks the ${REQUIRED_DAEMON_CAPABILITY} capability`);
		}

		const createResponse = await client
			.request({
				type: "create",
				name: this.options.sessionName ?? PRIME_DAEMON_SESSION_NAME,
				lifecycle: "client_owned",
				config: { cwd: this.options.workspace },
			})
			.catch((error: unknown) => {
				throw attachFailure(`create failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		if (!createResponse.success) {
			throw attachFailure(`create rejected: ${createResponse.error ?? "unknown daemon error"}`);
		}
		const summary = createResponse.data as { activeSessionId?: unknown };
		const activeSessionId = summary.activeSessionId;
		if (typeof activeSessionId !== "string" || activeSessionId.length === 0) {
			throw attachFailure("create returned no activeSessionId");
		}

		const attachResponse = await client
			.request({
				type: "attach",
				activeSessionId,
			})
			.catch((error: unknown) => {
				throw attachFailure(`attach failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		if (!attachResponse.success) {
			throw attachFailure(`attach rejected: ${attachResponse.error ?? "unknown daemon error"}`);
		}

		this.sessionId = activeSessionId;
		this.setState("ready");
		this.log(`attached prime daemon session ${activeSessionId} on ${socketPath}`);
	}

	private handleMessage(message: DaemonOutbound): void {
		if (message.type !== "session_event") {
			return;
		}
		if (this.sessionId === null || message.activeSessionId !== this.sessionId) {
			return;
		}
		const event: { type?: unknown } = message.event;
		if (typeof event.type !== "string" || !TRANSLATED_EVENT_TYPES.has(event.type)) {
			return;
		}
		for (const translated of this.translator.translate(message.event as unknown as RpcRecord)) {
			if (translated.type === "agent_state") {
				this.streaming = translated.state === "busy";
				this.setState(translated.state);
			}
			if (translated.type === "chat" && translated.role === "assistant") {
				this.lastAssistantText = translated.text;
			}
			this.emit(translated);
		}
	}
}
