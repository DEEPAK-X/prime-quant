import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "../src/events.js";
import { RpcSession } from "../src/rpc-session.js";

type FakeChild = EventEmitter & {
	pid: number;
	exitCode: number | null;
	stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = 4242;
	child.exitCode = null;
	child.stdin = { write: vi.fn(() => true), end: vi.fn() };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => {
		queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
		return true;
	});
	return child;
}

interface Harness {
	children: FakeChild[];
	spawnCalls: Array<{ command: string; args: string[] }>;
	spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

function createHarness(): Harness {
	const children: FakeChild[] = [];
	const spawnCalls: Harness["spawnCalls"] = [];
	const spawn = ((command: string, args: string[]) => {
		spawnCalls.push({ command, args });
		const child = createFakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	}) as Harness["spawn"];
	return { children, spawnCalls, spawn };
}

function writtenLines(child: FakeChild): string[] {
	return child.stdin.write.mock.calls.map((call) => String(call[0]));
}

function drive(child: FakeChild, record: Record<string, unknown>): void {
	child.stdout.emit("data", Buffer.from(`${JSON.stringify(record)}\n`));
}

/** Let pending microtasks (post-spawn send, promise continuations) flush. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Respond to the most recently written request line with success (or overrides). */
function respond(child: FakeChild, overrides: Record<string, unknown> = {}): void {
	const lines = writtenLines(child);
	const request = JSON.parse(lines[lines.length - 1]!) as { id?: string; type?: string };
	drive(child, { type: "response", id: request.id, command: request.type, success: true, data: {}, ...overrides });
}

async function startSession(session: RpcSession, harness: Harness): Promise<{ child: FakeChild; events: V2Event[] }> {
	const events: V2Event[] = [];
	session.subscribe((event) => events.push(event));
	const startPromise = session.start();
	await settle();
	const child = harness.children[harness.children.length - 1]!;
	respond(child);
	await startPromise;
	return { child, events };
}

describe("RpcSession over a fake RPC child", () => {
	let session: RpcSession | undefined;
	let harness: Harness;

	afterEach(async () => {
		vi.useRealTimers();
		await session?.stop();
		session = undefined;
	});

	it("starts the child with the RPC CLI args and exposes ready after the get_state probe", async () => {
		// A real (temp) repo root so the GUI session dir is creatable and the
		// bridge passes --session-dir; the other tests use a fake "/repo".
		const repoRoot = mkdtempSync(join(tmpdir(), "rpc-session-"));
		harness = createHarness();
		session = new RpcSession({ repoRoot, spawn: harness.spawn, commandTimeoutMs: 1000 });
		const { child } = await startSession(session, harness);
		expect(session.getAgentState()).toBe("ready");
		expect(harness.children.length).toBe(1);
		const { command, args } = harness.spawnCalls[0]!;
		expect(command).toBe(process.execPath);
		expect(args.join(" ")).toContain("packages/coding-agent/src/cli.ts");
		expect(args.join(" ")).toContain(`--mode rpc --cwd ${repoRoot} --session-dir`);
		// The very first write is the readiness probe.
		expect(writtenLines(child)[0]).toContain('"type":"get_state"');
	});

	it("prompt echoes the user chat and sends a plain prompt when idle", async () => {
		harness = createHarness();
		session = new RpcSession({ repoRoot: "/repo", spawn: harness.spawn, commandTimeoutMs: 1000 });
		const { child, events } = await startSession(session, harness);

		const promptPromise = session.prompt("hello");
		await settle();
		respond(child);
		await promptPromise;

		const userChats = events.filter(
			(event): event is Extract<V2Event, { type: "chat" }> => event.type === "chat" && event.role === "user",
		);
		expect(userChats).toHaveLength(1);
		expect(userChats[0]).toMatchObject({ role: "user", text: "hello" });
		expect(typeof (userChats[0] as { id: string }).id).toBe("string");
		const lines = writtenLines(child);
		const promptLine = lines.find((line) => line.includes('"type":"prompt"'));
		expect(promptLine).toBeDefined();
		expect(promptLine).toContain('"message":"hello"');
		expect(promptLine).not.toContain("streamingBehavior");
	});

	it("resends with streamingBehavior followUp while a turn is streaming", async () => {
		harness = createHarness();
		session = new RpcSession({ repoRoot: "/repo", spawn: harness.spawn, commandTimeoutMs: 1000 });
		const { child } = await startSession(session, harness);

		drive(child, { type: "agent_start" });
		await settle();
		expect(session.isBusy()).toBe(true);
		expect(session.getAgentState()).toBe("busy");

		const promptPromise = session.prompt("second");
		await settle();
		respond(child);
		await promptPromise;

		const lines = writtenLines(child);
		const followUpLine = lines.find((line) => line.includes('"type":"prompt"'));
		expect(followUpLine).toContain('"streamingBehavior":"followUp"');

		drive(child, { type: "agent_end" });
		await settle();
		expect(session.isBusy()).toBe(false);
		expect(session.getAgentState()).toBe("ready");
	});

	it("buffers the last assistant text from translated chat events", async () => {
		harness = createHarness();
		session = new RpcSession({ repoRoot: "/repo", spawn: harness.spawn, commandTimeoutMs: 1000 });
		const { child, events } = await startSession(session, harness);

		drive(child, { type: "message_start", message: { role: "assistant", timestamp: 1_700_000_000_000 } });
		drive(child, {
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", delta: "Hel" },
		});
		drive(child, {
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", delta: "lo" },
		});
		drive(child, {
			type: "message_end",
			message: { role: "assistant", timestamp: 1_700_000_000_000, content: [{ type: "text", text: "Hello world" }] },
		});
		await settle();

		expect(await session.getLastAssistantText()).toBe("Hello world");
		const chats = events.filter(
			(event): event is Extract<V2Event, { type: "chat" }> => event.type === "chat" && event.role === "assistant",
		);
		expect(chats).toHaveLength(1);
		expect(chats[0]).toMatchObject({ text: "Hello world" });
		const deltas = events.filter(
			(event): event is Extract<V2Event, { type: "chat_delta" }> => event.type === "chat_delta",
		);
		expect(deltas.map((delta) => delta.id)).toEqual([chats[0]!.id, chats[0]!.id]);
	});

	it("restarts on unexpected exit with capped backoff and stops after max attempts", async () => {
		vi.useFakeTimers();
		harness = createHarness();
		// maxMs 3000 caps the backoff (1s, 2s, then 3s instead of 4s);
		// maxAttempts 4 stops restarts after the fourth crash.
		session = new RpcSession({
			repoRoot: "/repo",
			spawn: harness.spawn,
			commandTimeoutMs: 1000,
			startTimeoutMs: 5000,
			restart: { initialMs: 1000, maxMs: 3000, maxAttempts: 4 },
		});
		const startPromise = session.start();
		await vi.advanceTimersByTimeAsync(0);
		respond(harness.children[0]!);
		await startPromise;
		expect(harness.children.length).toBe(1);

		// Crash child 1: restart scheduled in 1000ms.
		harness.children[0]!.exitCode = 1;
		harness.children[0]!.emit("exit", 1, null);
		expect(session.getAgentState()).toBe("error");

		// Each crash re-schedules with doubled backoff (capped at 3000ms); the
		// restarted child never answers the probe and is crashed in turn.
		// Crashes 1-4 schedule restarts (children 2-5); crash 5 trips the cap.
		const backoffs = [1000, 2000, 3000, 3000];
		for (const [index, backoff] of backoffs.entries()) {
			await vi.advanceTimersByTimeAsync(backoff);
			expect(harness.children.length).toBe(index + 2);
			harness.children[index + 1]!.exitCode = 1;
			harness.children[index + 1]!.emit("exit", 1, null);
		}
		// The fifth crash trips the attempt cap: no further spawn ever.
		expect(session.getAgentState()).toBe("error");
		expect(harness.children.length).toBe(5);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.children.length).toBe(5);
	});

	it("does not restart after an intentional stop", async () => {
		vi.useFakeTimers();
		harness = createHarness();
		session = new RpcSession({
			repoRoot: "/repo",
			spawn: harness.spawn,
			commandTimeoutMs: 1000,
			startTimeoutMs: 5000,
			restart: { initialMs: 1000, maxMs: 30_000, maxAttempts: 5 },
		});
		const startPromise = session.start();
		await vi.advanceTimersByTimeAsync(0);
		respond(harness.children[0]!);
		await startPromise;

		await session.stop();
		expect(session.getAgentState()).toBe("stopped");
		harness.children[0]!.emit("exit", 1, null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.children.length).toBe(1);
	});

	it("interrupt sends the RPC abort command", async () => {
		harness = createHarness();
		session = new RpcSession({ repoRoot: "/repo", spawn: harness.spawn, commandTimeoutMs: 1000 });
		const { child } = await startSession(session, harness);

		const interruptPromise = session.interrupt();
		await settle();
		respond(child);
		await interruptPromise;
		expect(writtenLines(child).some((line) => line.includes('"type":"abort"'))).toBe(true);
	});
});
