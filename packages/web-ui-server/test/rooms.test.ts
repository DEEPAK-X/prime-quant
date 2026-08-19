/**
 * A2 rooms model: registry bounds/validation plus bridge integration —
 * hello advertises rooms, room_message broadcasts respect per-client
 * subscribe filters, and the REST surface serves list/history/intake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentState, Mt5Status, V2Event } from "../src/events.js";
import { createV2GuiBridge, type V2BridgeMt5, type V2BridgeSession, type V2GuiBridge } from "../src/gui-bridge.js";
import { DEFAULT_ROOMS, isValidRoomId, MAX_ROOM_MESSAGES, RoomsRegistry } from "../src/rooms.js";

describe("RoomsRegistry", () => {
	it("seeds the default PLAN.md rooms", () => {
		const registry = new RoomsRegistry();
		expect(registry.list().map((room) => room.id)).toEqual(DEFAULT_ROOMS.map((room) => room.id));
	});

	it("posts bounded messages and validates ids", () => {
		const registry = new RoomsRegistry();
		expect(isValidRoomId("risk-management")).toBe(true);
		expect(isValidRoomId("Risk Room!")).toBe(false);

		expect(registry.post("alerts", "watcher://risk", "breach")).not.toBeNull();
		expect(registry.post("Invalid Room!", "watcher", "x")).toBeNull();
		expect(registry.post("alerts", "", "x")).toBeNull();
		expect(registry.post("alerts", "watcher", "  ")).toBeNull();

		for (let i = 0; i < MAX_ROOM_MESSAGES + 25; i++) {
			registry.post("alerts", "watcher://risk", `msg ${i}`);
		}
		const history = registry.history("alerts");
		expect(history.length).toBe(MAX_ROOM_MESSAGES);
		expect(history[history.length - 1].text).toBe(`msg ${MAX_ROOM_MESSAGES + 24}`);
	});

	it("creates valid unknown rooms on first post", () => {
		const registry = new RoomsRegistry();
		expect(registry.has("flow")).toBe(false);
		registry.post("flow", "watcher://flow", "volume spike");
		expect(registry.has("flow")).toBe(true);
		expect(registry.history("flow")[0].from).toBe("watcher://flow");
	});
});

const OK_MT5: Mt5Status = { status: "ok", detail: null, checkedAt: "2026-08-19T00:00:00Z" };

function createFakeSession(): V2BridgeSession {
	return {
		prompt: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		getAgentState: (): AgentState => "ready",
	};
}

function createFakeMt5(): V2BridgeMt5 {
	return {
		async getStatus() {
			return OK_MT5;
		},
		async refresh() {
			return OK_MT5;
		},
	};
}

interface TestSocket {
	ws: WebSocket;
	received: V2Event[];
	waitForType(type: string): Promise<V2Event>;
}

function openSocket(port: number): Promise<TestSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const received: V2Event[] = [];
		const waiters: Array<{ type: string; resolve: (event: V2Event) => void }> = [];
		const waitForType = (type: string): Promise<V2Event> => {
			const existing = received.find((event) => event.type === type);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve) => waiters.push({ type, resolve }));
		};
		ws.on("message", (data) => {
			const event = JSON.parse(data.toString()) as V2Event;
			received.push(event);
			for (const waiter of [...waiters]) {
				if (event.type === waiter.type) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(event);
				}
			}
		});
		ws.on("open", () => resolve({ ws, received, waitForType }));
		ws.on("error", reject);
	});
}

describe("v2 bridge: rooms", () => {
	let port = 4100;
	let bridge: V2GuiBridge | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-rooms-"));
		port += 1;
	});

	afterEach(async () => {
		await bridge?.stop();
		bridge = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function start(): Promise<number> {
		bridge = createV2GuiBridge({
			port,
			session: createFakeSession(),
			mt5: createFakeMt5(),
			sessionId: "test",
			artifactsRoot: tempDir,
		});
		await bridge.start();
		return port;
	}

	it("hello advertises rooms and sends rooms_state", async () => {
		const current = await start();
		const socket = await openSocket(current);
		const hello = (await socket.waitForType("hello")) as Extract<V2Event, { type: "hello" }>;
		expect(hello.rooms).toEqual(DEFAULT_ROOMS.map((room) => room.id));
		const state = (await socket.waitForType("rooms_state")) as Extract<V2Event, { type: "rooms_state" }>;
		expect(state.rooms.length).toBe(DEFAULT_ROOMS.length);
		socket.ws.close();
	});

	it("POST /api/rooms/:id/messages stores, broadcasts, and REST-serves history", async () => {
		const current = await start();
		const socket = await openSocket(current);
		await socket.waitForType("hello");

		const post = await fetch(`http://127.0.0.1:${current}/api/rooms/risk-management/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "watcher://risk", text: "drawdown 6.2% exceeds 5% limit" }),
		});
		expect(post.status).toBe(201);

		const event = (await socket.waitForType("room_message")) as Extract<V2Event, { type: "room_message" }>;
		expect(event.room).toBe("risk-management");
		expect(event.from).toBe("watcher://risk");

		const history = (await (
			await fetch(`http://127.0.0.1:${current}/api/rooms/risk-management/messages`)
		).json()) as { messages: Array<{ text: string }> };
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0].text).toContain("6.2%");
		socket.ws.close();
	});

	it("subscribe narrows a client's room_message feed", async () => {
		const current = await start();
		const narrow = await openSocket(current);
		await narrow.waitForType("hello");
		narrow.ws.send(JSON.stringify({ type: "subscribe", rooms: ["alerts"] }));

		const wide = await openSocket(current);
		await wide.waitForType("hello");

		bridge?.emit({ type: "room_message", room: "research", id: "rm-1", from: "w", text: "skip me", ts: "t" });
		bridge?.emit({ type: "room_message", room: "alerts", id: "rm-2", from: "w", text: "keep me", ts: "t" });

		const alerts = await narrow.waitForType("room_message");
		expect(alerts.type).toBe("room_message");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const narrowRooms = narrow.received
			.filter((event) => event.type === "room_message")
			.map((event) => (event as Extract<V2Event, { type: "room_message" }>).room);
		expect(narrowRooms).toEqual(["alerts"]);

		const wideRooms = wide.received.filter((event) => event.type === "room_message");
		expect(wideRooms).toHaveLength(2);
		narrow.ws.close();
		wide.ws.close();
	});

	it("rejects invalid posts and unknown rooms", async () => {
		const current = await start();
		const bad = await fetch(`http://127.0.0.1:${current}/api/rooms/alerts/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: "watcher" }),
		});
		expect(bad.status).toBe(400);
		const unknown = await fetch(`http://127.0.0.1:${current}/api/rooms/nope/messages`);
		expect(unknown.status).toBe(404);
	});

	it("automatically posts tearsheet artifact link to #research room on pipeline completion", async () => {
		const current = await start();
		const socket = await openSocket(current);
		await socket.waitForType("hello");

		bridge?.emit({
			type: "tearsheet",
			name: "tearsheet_EURUSD_M5.html",
			url: "/reports/tearsheet_EURUSD_M5.html",
			ts: "2026-08-19T21:00:00Z",
		});

		const messageEvent = (await socket.waitForType("room_message")) as Extract<V2Event, { type: "room_message" }>;
		expect(messageEvent.room).toBe("research");
		expect(messageEvent.from).toBe("pipeline");
		expect(messageEvent.text).toContain("[tearsheet_EURUSD_M5.html](/reports/tearsheet_EURUSD_M5.html)");

		const res = await fetch(`http://127.0.0.1:${current}/api/rooms/research/messages`);
		const history = (await res.json()) as { messages: Array<{ text: string; from: string }> };
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0].from).toBe("pipeline");
		expect(history.messages[0].text).toContain("tearsheet_EURUSD_M5.html");
		socket.ws.close();
	});
});
