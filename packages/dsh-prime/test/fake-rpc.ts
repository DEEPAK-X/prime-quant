import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi } from "vitest";

export type FakeChild = EventEmitter & {
	pid: number;
	exitCode: number | null;
	stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

export function createFakeChild(): FakeChild {
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

export interface RpcHarness {
	children: FakeChild[];
	spawnCalls: Array<{ command: string; args: string[] }>;
	spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function createRpcHarness(): RpcHarness {
	const children: FakeChild[] = [];
	const spawnCalls: RpcHarness["spawnCalls"] = [];
	const spawn = ((command: string, args: string[]) => {
		spawnCalls.push({ command, args });
		const child = createFakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	}) as RpcHarness["spawn"];
	return { children, spawnCalls, spawn };
}

export function writtenLines(child: FakeChild): string[] {
	return child.stdin.write.mock.calls.map((call) => String(call[0]));
}

export function drive(child: FakeChild, record: Record<string, unknown>): void {
	child.stdout.emit("data", Buffer.from(`${JSON.stringify(record)}\n`));
}

export function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function respond(child: FakeChild, overrides: Record<string, unknown> = {}): void {
	const lines = writtenLines(child);
	const request = JSON.parse(lines[lines.length - 1]!) as { id?: string; type?: string };
	drive(child, { type: "response", id: request.id, command: request.type, success: true, data: {}, ...overrides });
}
