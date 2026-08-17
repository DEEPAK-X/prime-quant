import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentState, Mt5Status, V2Event } from "../src/events.js";
import { createV2GuiBridge, type V2BridgeMt5, type V2BridgeSession, type V2GuiBridge } from "../src/gui-bridge.js";

const OK_MT5: Mt5Status = {
	status: "ok",
	detail: { server: "XMGlobal-MT5 6", login: 1301549953, symbols: 1640 },
	checkedAt: "2026-08-17T12:00:00Z",
};

function createFakeSession(): V2BridgeSession {
	return {
		prompt: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		getAgentState: (): AgentState => "ready",
	};
}

function createFakeMt5(): V2BridgeMt5 & { refreshCount: number } {
	const service: V2BridgeMt5 & { refreshCount: number } = {
		refreshCount: 0,
		async getStatus() {
			return OK_MT5;
		},
		async refresh() {
			service.refreshCount += 1;
			return { ...OK_MT5, checkedAt: "2026-08-17T12:00:30Z" };
		},
	};
	return service;
}

interface TestSocket {
	ws: WebSocket;
	received: unknown[];
	/** Resolve once `count` messages have arrived since open. */
	waitFor(count: number): Promise<unknown[]>;
}

/** Open /ws with a message buffer attached before open, so no frame is missed. */
function openSocket(port: number): Promise<TestSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const received: unknown[] = [];
		const waiters: Array<{ count: number; resolve: (messages: unknown[]) => void }> = [];
		const waitFor = (count: number): Promise<unknown[]> => {
			if (received.length >= count) {
				return Promise.resolve(received.slice(0, count));
			}
			return new Promise((resolve) => waiters.push({ count, resolve }));
		};
		ws.on("message", (data) => {
			received.push(JSON.parse(data.toString()) as unknown);
			for (const waiter of [...waiters]) {
				if (received.length >= waiter.count) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(received.slice(0, waiter.count));
				}
			}
		});
		ws.on("open", () => resolve({ ws, received, waitFor }));
		ws.on("error", reject);
	});
}

describe("v2 bridge: hello frame, broadcasts, and REST snapshots", () => {
	let port = 3970;
	let bridge: V2GuiBridge | undefined;
	let session: V2BridgeSession;
	let mt5: V2BridgeMt5 & { refreshCount: number };
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-v2-bridge-"));
		port += 1;
		session = createFakeSession();
		mt5 = createFakeMt5();
	});

	afterEach(async () => {
		await bridge?.stop();
		bridge = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function start(): Promise<void> {
		bridge = createV2GuiBridge({
			port,
			host: "127.0.0.1",
			session,
			mt5,
			sessionId: "gui-session",
			artifactsRoot: tempDir,
		});
		await bridge.start();
	}

	it("sends hello as the first frame with protocol 2 and mt5 status", async () => {
		await start();
		const socket = await openSocket(port);
		const messages = await socket.waitFor(1);
		socket.ws.close();
		expect(messages[0]).toMatchObject({
			type: "hello",
			protocol: 2,
			backend: "bridge",
			agentState: "starting",
			sessionId: "gui-session",
			mt5: OK_MT5,
		});
	});

	it("broadcasts emitted events and mirrors them into REST snapshots", async () => {
		await start();
		const socket = await openSocket(port);
		await socket.waitFor(1); // hello
		const messagesPromise = socket.waitFor(4); // hello + 3 emitted

		bridge!.emit({ type: "agent_state", state: "ready" });
		bridge!.emit({ type: "subagent", id: "sub-1", tier: "worker", status: "RUNNING", task: "param sweep" });
		bridge!.emit({ type: "artifact", kind: "py", name: "eurusd_m5_sma.py", content: "print(1)" });

		const messages = await messagesPromise;
		socket.ws.close();
		expect(messages.map((message) => (message as V2Event).type)).toEqual([
			"hello",
			"agent_state",
			"subagent",
			"artifact",
		]);

		const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
		expect(health).toEqual({ ok: true, backend: "bridge", agentState: "ready" });

		const subagents = await (await fetch(`http://127.0.0.1:${port}/api/subagents`)).json();
		expect(subagents).toEqual({
			subagents: [expect.objectContaining({ id: "sub-1", tier: "worker", status: "RUNNING" })],
		});

		const artifacts = await (await fetch(`http://127.0.0.1:${port}/api/artifacts?kind=py`)).json();
		expect(artifacts).toEqual({ artifacts: [expect.objectContaining({ kind: "py", name: "eurusd_m5_sma.py" })] });

		const emptyMq5 = await (await fetch(`http://127.0.0.1:${port}/api/artifacts?kind=mq5`)).json();
		expect(emptyMq5).toEqual({ artifacts: [] });

		const latest = await fetch(`http://127.0.0.1:${port}/api/tearsheet/latest`);
		expect(latest.status).toBe(204);
	});

	it("tracks tearsheet events and serves /api/tearsheets newest-first", async () => {
		await start();
		bridge!.emit({
			type: "tearsheet",
			url: "/reports/old.html",
			name: "old.html",
			ts: "2026-08-17T10:00:00Z",
		});
		bridge!.emit({
			type: "tearsheet",
			url: "/reports/new.html",
			name: "new.html",
			ts: "2026-08-17T11:00:00Z",
		});
		const latest = await (await fetch(`http://127.0.0.1:${port}/api/tearsheet/latest`)).json();
		expect(latest).toEqual({ url: "/reports/new.html", name: "new.html", ts: "2026-08-17T11:00:00Z" });
		const list = await (await fetch(`http://127.0.0.1:${port}/api/tearsheets`)).json();
		expect((list as { tearsheets: Array<{ name: string }> }).tearsheets.map((entry) => entry.name)).toEqual([
			"new.html",
			"old.html",
		]);
	});

	it("forwards chat and interrupt to the session and refresh_mt5 to the probe", async () => {
		await start();
		const socket = await openSocket(port);
		await socket.waitFor(1); // hello

		socket.ws.send(JSON.stringify({ type: "chat", text: "  Analyse EURUSD M5  " }));
		socket.ws.send(JSON.stringify({ type: "interrupt" }));
		const refreshPromise = socket.waitFor(2); // the refreshed hello
		socket.ws.send(JSON.stringify({ type: "refresh_mt5" }));

		const messages = await refreshPromise;
		socket.ws.close();
		expect(session.prompt).toHaveBeenCalledWith("Analyse EURUSD M5");
		expect(session.interrupt).toHaveBeenCalledTimes(1);
		expect(mt5.refreshCount).toBe(1);
		expect(messages[1]).toMatchObject({ type: "hello", mt5: { status: "ok" } });
	});

	it("serves reports from the root and rejects traversal and separators", async () => {
		writeFileSync(join(tempDir, "tearsheet_EURUSD_M5.html"), "<html>ok</html>");
		await start();

		const ok = await fetch(`http://127.0.0.1:${port}/reports/tearsheet_EURUSD_M5.html`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("text/html");
		expect(await ok.text()).toBe("<html>ok</html>");

		// Encoded traversal must be rejected after decoding.
		const traversal = await fetch(`http://127.0.0.1:${port}/reports/${encodeURIComponent("..%2F..%2Fetc%2Fpasswd")}`);
		expect(traversal.status).toBe(404);
		const slash = await fetch(`http://127.0.0.1:${port}/reports/${encodeURIComponent("sub/dir.html")}`);
		expect(slash.status).toBe(404);
		const missing = await fetch(`http://127.0.0.1:${port}/reports/nope.html`);
		expect(missing.status).toBe(404);
	});

	it("returns 404 for unknown paths and 405 for wrong methods", async () => {
		await start();
		const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: "not found" });

		const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "POST" });
		expect(wrongMethod.status).toBe(405);

		const badKind = await fetch(`http://127.0.0.1:${port}/api/artifacts?kind=exe`);
		expect(badKind.status).toBe(400);
	});
});
