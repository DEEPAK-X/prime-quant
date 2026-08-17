import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcChildClient } from "../src/rpc-client.js";

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
	child.pid = 1234;
	child.exitCode = null;
	child.stdin = { write: vi.fn(() => true), end: vi.fn() };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => true);
	return child;
}

function createClient(options: { commandTimeoutMs?: number } = {}): {
	client: RpcChildClient;
	child: FakeChild;
} {
	const child = createFakeChild();
	const spawn = ((_command: string, _args: string[], _options: SpawnOptions) => child) as unknown as (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => ChildProcess;
	const client = new RpcChildClient({ repoRoot: "/repo", spawn, commandTimeoutMs: options.commandTimeoutMs ?? 1000 });
	return { client, child };
}

function emitData(child: FakeChild, text: string): void {
	child.stdout.emit("data", Buffer.from(text));
}

function writtenLines(child: FakeChild): string[] {
	return child.stdin.write.mock.calls.map((call) => String(call[0]));
}

describe("RpcChildClient JSONL framing", () => {
	let fake: ReturnType<typeof createClient> | undefined;

	afterEach(async () => {
		vi.useRealTimers();
		await fake?.client.stop();
		fake = undefined;
	});

	it("splits records on \\n only and strips one trailing \\r", async () => {
		fake = createClient();
		const { client, child } = fake;
		const records: Array<Record<string, unknown>> = [];
		client.onRecord((record) => records.push(record as Record<string, unknown>));
		await client.start();

		// Two records in one chunk, plus a CRLF-terminated record.
		emitData(child, '{"type":"a"}\r\n{"type":"b"}\n');
		emitData(child, '{"type":"c"}\n');
		await new Promise((resolve) => setImmediate(resolve));

		expect(records.map((record) => record.type)).toEqual(["a", "b", "c"]);
	});

	it("joins a single record split across many chunks", async () => {
		fake = createClient();
		const { client, child } = fake;
		const records: Array<Record<string, unknown>> = [];
		client.onRecord((record) => records.push(record as Record<string, unknown>));
		await client.start();

		const record = JSON.stringify({ type: "big", text: "x".repeat(200_000) });
		// Deliver in 16KB pieces.
		for (let offset = 0; offset < record.length; offset += 16_384) {
			emitData(child, record.slice(offset, offset + 16_384));
		}
		emitData(child, "\n");
		await new Promise((resolve) => setImmediate(resolve));

		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(JSON.parse(record));
	});

	it("tolerates unparseable lines and keeps delivering valid records", async () => {
		fake = createClient();
		const { client, child } = fake;
		const records: Array<Record<string, unknown>> = [];
		client.onRecord((record) => records.push(record as Record<string, unknown>));
		await client.start();

		emitData(child, "not json at all\n");
		emitData(child, '{"type":"ok"}\n');
		await new Promise((resolve) => setImmediate(resolve));

		expect(records.map((record) => record.type)).toEqual(["ok"]);
	});

	it("does not split on U+2028/U+2029 inside JSON strings", async () => {
		fake = createClient();
		const { client, child } = fake;
		const records: Array<Record<string, unknown>> = [];
		client.onRecord((record) => records.push(record as Record<string, unknown>));
		await client.start();

		// U+2028 and U+2029 are legal inside JSON strings; readline would split here.
		emitData(child, `${JSON.stringify({ type: "x", text: "a\u2028b\u2029c" })}\n`);
		await new Promise((resolve) => setImmediate(resolve));

		expect(records).toHaveLength(1);
		expect(records[0]).toEqual({ type: "x", text: "a\u2028b\u2029c" });
	});
});

describe("RpcChildClient command correlation", () => {
	let fake: ReturnType<typeof createClient> | undefined;

	afterEach(async () => {
		vi.useRealTimers();
		await fake?.client.stop();
		fake = undefined;
	});

	it("resolves a send when the matching response id arrives and fans out unrelated records", async () => {
		fake = createClient();
		const { client, child } = fake;
		const records: Array<Record<string, unknown>> = [];
		client.onRecord((record) => records.push(record as Record<string, unknown>));
		await client.start();

		const sendPromise = client.send({ type: "get_state" });
		const request = JSON.parse(writtenLines(child)[0]!) as { id: string };
		// An unrelated event is fanned out…
		emitData(child, '{"type":"agent_start"}\n');
		// …then the matching response resolves the send.
		emitData(child, `${JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true })}\n`);
		const response = await sendPromise;

		expect(response).toMatchObject({ type: "response", id: request.id, command: "get_state", success: true });
		expect(records.map((record) => record.type)).toEqual(["agent_start"]);
	});

	it("rejects with a timeout when no response arrives", async () => {
		vi.useFakeTimers();
		fake = createClient({ commandTimeoutMs: 100 });
		const { client } = fake;
		await client.start();

		const sendPromise = client.send({ type: "get_state" });
		const rejection = expect(sendPromise).rejects.toThrow(/Timeout waiting for response to get_state/);
		await vi.advanceTimersByTimeAsync(100);
		await rejection;
	});

	it("rejects in-flight sends when the child exits", async () => {
		fake = createClient();
		const { client, child } = fake;
		await client.start();

		const sendPromise = client.send({ type: "prompt", message: "hello" });
		child.exitCode = 1;
		child.emit("exit", 1, null);
		await expect(sendPromise).rejects.toThrow(/RPC child exited \(1\)/);
	});
});
