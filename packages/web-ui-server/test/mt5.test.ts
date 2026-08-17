import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMt5Probe, parseProbeOutput } from "../src/mt5.js";

type FakeChild = EventEmitter & {
	pid: number;
	exitCode: number | null;
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = 9001;
	child.exitCode = null;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => true);
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

function emitLine(child: FakeChild, line: string): void {
	child.stdout.emit("data", Buffer.from(`${line}\n`));
	child.exitCode = 0;
	child.emit("exit", 0, null);
}

function okStatus() {
	return {
		status: "ok",
		detail: { server: "XMGlobal-MT5 6", login: 1301549953, symbols: 1640 },
		checkedAt: expect.any(String),
	};
}

function downStatus() {
	return { status: "down", detail: null, checkedAt: expect.any(String) };
}

describe("parseProbeOutput", () => {
	it("parses an ok probe line with detail", () => {
		expect(
			parseProbeOutput('{"status":"ok","detail":{"server":"XMGlobal-MT5 6","login":1301549953,"symbols":1640}}'),
		).toEqual(okStatus());
	});

	it("parses a down probe line", () => {
		expect(parseProbeOutput('{"status":"down","reason":"initialize() returned false"}')).toEqual(downStatus());
	});

	it("returns null for unparseable or unexpected payloads", () => {
		expect(parseProbeOutput("")).toBeNull();
		expect(parseProbeOutput("not json")).toBeNull();
		expect(parseProbeOutput('{"status":"weird"}')).toBeNull();
		expect(parseProbeOutput("[1,2]")).toBeNull();
	});
});

describe("createMt5Probe over a fake python child", () => {
	let probe: ReturnType<typeof createMt5Probe> | undefined;
	let harness: Harness;
	let tempDir: string;
	let fakePython: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-mt5-probe-"));
		fakePython = join(tempDir, "python");
		writeFileSync(fakePython, "");
	});

	afterEach(() => {
		vi.useRealTimers();
		probe = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeProbe(options: { cacheMs?: number; timeoutMs?: number; pythonPath?: string } = {}): void {
		harness = createHarness();
		probe = createMt5Probe({
			pythonPath: options.pythonPath ?? fakePython,
			spawn: harness.spawn,
			cacheMs: options.cacheMs ?? 30_000,
			timeoutMs: options.timeoutMs ?? 10_000,
		});
	}

	it("probes through the venv python and resolves ok with server/login/symbols", async () => {
		makeProbe();
		const promise = probe!.getStatus();
		expect(harness.children).toHaveLength(1);
		expect(harness.spawnCalls[0]!.command).toBe(fakePython);
		expect(harness.spawnCalls[0]!.args[0]).toBe("-c");
		emitLine(
			harness.children[0]!,
			'{"status":"ok","detail":{"server":"XMGlobal-MT5 6","login":1301549953,"symbols":1640}}',
		);
		await expect(promise).resolves.toEqual(okStatus());
	});

	it("resolves down when the probe reports a failed initialize", async () => {
		makeProbe();
		const promise = probe!.getStatus();
		emitLine(harness.children[0]!, '{"status":"down","reason":"initialize() returned false"}');
		await expect(promise).resolves.toEqual(downStatus());
	});

	it("resolves unknown without spawning when the venv python is missing", async () => {
		makeProbe({ pythonPath: "/nonexistent/python" });
		await expect(probe!.getStatus()).resolves.toEqual({
			status: "unknown",
			detail: null,
			checkedAt: expect.any(String),
		});
		expect(harness.spawnCalls).toHaveLength(0);
	});

	it("kills the child and resolves down on timeout", async () => {
		vi.useFakeTimers();
		makeProbe({ timeoutMs: 100 });
		const promise = probe!.getStatus();
		// The fake child never answers; the timer must fire.
		await vi.advanceTimersByTimeAsync(100);
		await expect(promise).resolves.toEqual(downStatus());
		expect(harness.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("serves a second call from cache without spawning again", async () => {
		makeProbe();
		const first = probe!.getStatus();
		emitLine(harness.children[0]!, '{"status":"ok","detail":{"server":"S","login":1,"symbols":2}}');
		await first;
		await expect(probe!.getStatus()).resolves.toMatchObject({ status: "ok" });
		expect(harness.spawnCalls).toHaveLength(1);
	});

	it("refresh bypasses the cache and spawns a fresh probe", async () => {
		makeProbe();
		const first = probe!.getStatus();
		emitLine(harness.children[0]!, '{"status":"ok","detail":{"server":"S","login":1,"symbols":2}}');
		await first;
		const second = probe!.refresh();
		expect(harness.spawnCalls).toHaveLength(2);
		emitLine(harness.children[1]!, '{"status":"down","reason":"terminal closed"}');
		await expect(second).resolves.toEqual(downStatus());
	});

	it("dedupes concurrent calls into a single in-flight probe", async () => {
		makeProbe();
		const first = probe!.getStatus();
		const second = probe!.getStatus();
		expect(harness.spawnCalls).toHaveLength(1);
		emitLine(harness.children[0]!, '{"status":"ok","detail":{"server":"S","login":1,"symbols":2}}');
		await expect(Promise.all([first, second])).resolves.toEqual([
			expect.objectContaining({ status: "ok" }),
			expect.objectContaining({ status: "ok" }),
		]);
	});
});
