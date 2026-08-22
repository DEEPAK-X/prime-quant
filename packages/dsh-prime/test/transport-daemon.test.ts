import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "@earendil-works/pi-coding-agent";
import type { V2Event } from "@earendil-works/pi-web-ui-server";
import { describe, expect, test } from "vitest";
import {
	isAttachFailure,
	PRIME_DAEMON_SESSION_NAME,
	PrimeDaemonTransport,
	type PrimeDaemonTransportClient,
} from "../src/host/transport-daemon.js";

const OK: DaemonResponse = { type: "response", command: "", success: true };

function sessionEvent(activeSessionId: string, event: Record<string, unknown>): DaemonOutbound {
	return { type: "session_event", activeSessionId, event } as unknown as DaemonOutbound;
}

class FakeDaemonClient implements PrimeDaemonTransportClient {
	readonly sent: DaemonCommand[] = [];
	closed = 0;
	private listener: ((message: DaemonOutbound) => void) | null = null;

	constructor(
		private readonly options: {
			protocolVersion?: number;
			serverCapabilities?: readonly string[];
			createData?: unknown;
			failCreate?: boolean;
		} = {},
	) {}

	async connect(): Promise<void> {}

	async waitForHello() {
		return {
			protocol: { version: this.options.protocolVersion ?? DAEMON_PROTOCOL_VERSION },
			serverCapabilities: this.options.serverCapabilities ?? [
				"attach_snapshot",
				"event_sequence",
				"client_owned_sessions",
			],
		};
	}

	async request(command: DaemonCommand): Promise<DaemonResponse> {
		this.sent.push(command);
		if (command.type === "create") {
			if (this.options.failCreate) {
				return { type: "response", command: "create", success: false, error: "no new sessions" };
			}
			return {
				type: "response",
				command: "create",
				success: true,
				data: this.options.createData ?? { activeSessionId: "s1" },
			};
		}
		return { ...OK, command: command.type };
	}

	onMessage(listener: (message: DaemonOutbound) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}

	emit(message: DaemonOutbound): void {
		this.listener?.(message);
	}

	close(): void {
		this.closed += 1;
	}
}

function makeTransport(client: FakeDaemonClient) {
	const transport = new PrimeDaemonTransport({
		workspace: "C:/repo",
		clientFactory: () => client,
		log: () => {},
	});
	return transport;
}

describe("PrimeDaemonTransport ensure/attach", () => {
	test("creates and attaches a dedicated client-owned session", async () => {
		const client = new FakeDaemonClient();
		const transport = makeTransport(client);
		await transport.ensure();
		expect(client.sent.map((command) => command.type)).toEqual(["create", "attach"]);
		const create = client.sent[0]!;
		if (create.type !== "create") throw new Error("expected create");
		expect(create.name).toBe(PRIME_DAEMON_SESSION_NAME);
		expect(create.lifecycle).toBe("client_owned");
		expect(create.config?.cwd).toBe("C:/repo");
		const attach = client.sent[1]!;
		if (attach.type !== "attach") throw new Error("expected attach");
		expect(attach.activeSessionId).toBe("s1");
		await transport.stop();
	});

	test("ensure is idempotent while attached", async () => {
		const client = new FakeDaemonClient();
		const transport = makeTransport(client);
		await transport.ensure();
		await transport.ensure();
		expect(client.sent.filter((command) => command.type === "create")).toHaveLength(1);
		await transport.stop();
	});

	test("fails closed without the client_owned_sessions capability", async () => {
		const client = new FakeDaemonClient({ serverCapabilities: ["attach_snapshot"] });
		const transport = makeTransport(client);
		let first: unknown;
		await transport.ensure().catch((caught) => {
			first = caught;
		});
		expect(first).toBeInstanceOf(Error);
		expect((first as Error).message).toContain("client_owned_sessions");
		expect(isAttachFailure(first)).toBe(true);
		expect(client.sent).toHaveLength(0);
	});

	test("fails closed on a stale protocol version", async () => {
		const client = new FakeDaemonClient({ protocolVersion: DAEMON_PROTOCOL_VERSION - 1 });
		const transport = makeTransport(client);
		let error: unknown;
		await transport.ensure().catch((caught) => {
			error = caught;
		});
		expect(error).toBeInstanceOf(Error);
		expect(isAttachFailure(error)).toBe(true);
		expect(client.sent).toHaveLength(0);
	});

	test("fails closed when the daemon rejects the create", async () => {
		const client = new FakeDaemonClient({ failCreate: true });
		const transport = makeTransport(client);
		await expect(transport.ensure()).rejects.toThrow(/create rejected/);
	});

	test("marks state error and closes the client on failed attach", async () => {
		const client = new FakeDaemonClient({ failCreate: true });
		const transport = makeTransport(client);
		await transport.ensure().catch(() => undefined);
		expect(transport.getAgentState()).toBe("error");
		expect(client.closed).toBe(1);
	});
});

describe("PrimeDaemonTransport events", () => {
	async function attached(client: FakeDaemonClient): Promise<InstanceType<typeof PrimeDaemonTransport>> {
		const transport = makeTransport(client);
		await transport.ensure();
		return transport;
	}

	test("translates daemon agent events into v2 events for the attached session", async () => {
		const client = new FakeDaemonClient();
		const transport = await attached(client);
		const seen: V2Event[] = [];
		transport.subscribe((event) => seen.push(event));

		client.emit(sessionEvent("s1", { type: "message_start", message: { role: "assistant" } }));
		client.emit(
			sessionEvent("s1", {
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			}),
		);
		client.emit(
			sessionEvent("s1", {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hello world" }], timestamp: 0 },
			}),
		);

		expect(seen.some((event) => event.type === "chat_delta" && event.delta === "hello")).toBe(true);
		const final = seen.find((event) => event.type === "chat");
		expect(final && final.role === "assistant" && final.text === "hello world").toBe(true);
		expect(await transport.getLastAssistantText()).toBe("hello world");
		await transport.stop();
	});

	test("tracks busy state from agent lifecycle events", async () => {
		const client = new FakeDaemonClient();
		const transport = await attached(client);
		expect(transport.isBusy()).toBe(false);
		client.emit(sessionEvent("s1", { type: "agent_start" }));
		expect(transport.isBusy()).toBe(true);
		expect(transport.getAgentState()).toBe("busy");
		client.emit(sessionEvent("s1", { type: "agent_end", messages: [] }));
		expect(transport.isBusy()).toBe(false);
		expect(transport.getAgentState()).toBe("ready");
		await transport.stop();
	});

	test("ignores events for other sessions and non-agent event families", async () => {
		const client = new FakeDaemonClient();
		const transport = await attached(client);
		const seen: V2Event[] = [];
		transport.subscribe((event) => seen.push(event));
		client.emit(sessionEvent("other", { type: "agent_start" }));
		client.emit(sessionEvent("s1", { type: "rlm_child_update", child: {} }));
		expect(seen).toHaveLength(0);
		await transport.stop();
	});
});

describe("PrimeDaemonTransport prompt/abort/stop", () => {
	test("prompt ensures attach then sends the trimmed message", async () => {
		const client = new FakeDaemonClient();
		const transport = makeTransport(client);
		await transport.prompt("  run it  ");
		const prompts = client.sent.filter((command) => command.type === "prompt");
		expect(prompts).toHaveLength(1);
		if (prompts[0]!.type !== "prompt") throw new Error("expected prompt");
		expect(prompts[0]!.message).toBe("run it");
		await transport.stop();
	});

	test("abort is a no-op before attach and sends abort afterwards", async () => {
		const client = new FakeDaemonClient();
		const transport = makeTransport(client);
		await transport.abort();
		expect(client.sent).toHaveLength(0);
		await transport.ensure();
		await transport.abort();
		expect(client.sent.filter((command) => command.type === "abort")).toHaveLength(1);
		await transport.stop();
	});

	test("stop detaches and closes without ever sending shutdown", async () => {
		const client = new FakeDaemonClient();
		const transport = makeTransport(client);
		await transport.ensure();
		await transport.stop();
		expect(client.sent.map((command) => command.type)).toEqual(["create", "attach", "detach"]);
		expect(client.closed).toBe(1);
		expect(transport.getAgentState()).toBe("stopped");
		await expect(transport.ensure()).rejects.toThrow(/stopped/);
	});
});
