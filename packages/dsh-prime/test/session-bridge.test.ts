import type { V2Event } from "@earendil-works/pi-web-ui-server";

import { EventTranslator, type RpcRecord, sniffCard } from "@earendil-works/pi-web-ui-server";
import { describe, expect, it } from "vitest";

import { v2ToPrimeSessionEvents } from "../src/host/session-bridge.js";

function translateAll(records: RpcRecord[]): V2Event[] {
	const translator = new EventTranslator({ cardSniffer: sniffCard });
	const events: V2Event[] = [];
	for (const record of records) {
		events.push(...translator.translate(record));
	}
	return events;
}

describe("v2ToPrimeSessionEvents", () => {
	it("maps assistant deltas then a final assistant message; drops user chat", () => {
		const deltas = v2ToPrimeSessionEvents({ type: "chat_delta", id: "msg-1", delta: "Hel" });
		const more = v2ToPrimeSessionEvents({ type: "chat_delta", id: "msg-1", delta: "lo" });
		const final = v2ToPrimeSessionEvents({
			type: "chat",
			role: "assistant",
			text: "Hello",
			id: "msg-1",
			ts: "2026-08-22T00:00:00Z",
		});
		const user = v2ToPrimeSessionEvents({
			type: "chat",
			role: "user",
			text: "hi",
			id: "u-1",
			ts: "2026-08-22T00:00:00Z",
		});
		expect(deltas).toEqual([{ type: "assistant/chunk", data: { id: "msg-1", delta: "Hel" } }]);
		expect(more).toEqual([{ type: "assistant/chunk", data: { id: "msg-1", delta: "lo" } }]);
		expect(final).toEqual([
			{ type: "assistant/message", data: { id: "msg-1", text: "Hello", ts: "2026-08-22T00:00:00Z" } },
		]);
		expect(user).toEqual([]);
	});

	it("keeps stepId stable across running → done", () => {
		const running = v2ToPrimeSessionEvents({
			type: "step",
			id: "run-42-backtest",
			name: "backtest",
			status: "running",
		});
		const done = v2ToPrimeSessionEvents({
			type: "step",
			id: "run-42-backtest",
			name: "backtest",
			status: "done",
			detail: "sharpe 1.2",
		});
		expect(running[0]).toMatchObject({ type: "prime/step", data: { stepId: "run-42-backtest", status: "running" } });
		expect(done[0]).toMatchObject({
			type: "prime/step",
			data: { stepId: "run-42-backtest", status: "done", detail: "sharpe 1.2" },
		});
	});

	it("round-trips a card payload and rewrites tearsheet urls to /prime-reports/", () => {
		const card = v2ToPrimeSessionEvents({
			type: "card",
			id: "c1",
			title: "Backtest · EURUSD M5",
			payload: { status: "success", metrics: { sharpe_ratio: 1.84 }, validation_gate: { passed: true } },
		});
		expect(card).toEqual([
			{
				type: "prime/card",
				data: {
					cardId: "c1",
					title: "Backtest · EURUSD M5",
					payload: { status: "success", metrics: { sharpe_ratio: 1.84 }, validation_gate: { passed: true } },
				},
			},
		]);
		const fromBridge = v2ToPrimeSessionEvents({
			type: "tearsheet",
			url: "/reports/tearsheet_EURUSD_M5.html",
			name: "tearsheet_EURUSD_M5.html",
			ts: "2026-08-22T00:00:00Z",
		});
		expect(fromBridge).toEqual([
			{
				type: "prime/tearsheet",
				data: {
					url: "/prime-reports/tearsheet_EURUSD_M5.html",
					name: "tearsheet_EURUSD_M5.html",
					ts: "2026-08-22T00:00:00Z",
				},
			},
		]);
	});

	it("ignores unknown v2 types (agent_state, thinking, hello, rooms)", () => {
		expect(v2ToPrimeSessionEvents({ type: "agent_state", state: "ready" })).toEqual([]);
		expect(v2ToPrimeSessionEvents({ type: "thinking", id: "t1", delta: "hmm", done: false })).toEqual([]);
		expect(
			v2ToPrimeSessionEvents({
				type: "hello",
				protocol: 2,
				backend: "bridge",
				agentState: "ready",
				sessionId: "gui-session",
				mt5: { status: "unknown", detail: null, checkedAt: null },
			}),
		).toEqual([]);
		expect(v2ToPrimeSessionEvents({ type: "rooms_state", rooms: [] })).toEqual([]);
	});

	it("lifts a card-sniffed assistant message through EventTranslator", () => {
		const payload = {
			status: "success",
			metrics: { sharpe_ratio: 1.84 },
			validation_gate: { passed: true },
			spec: { symbol: "EURUSD", timeframe: "M5" },
		};
		const text = JSON.stringify(payload);
		const v2 = translateAll([
			{ type: "message_start", message: { role: "assistant", timestamp: 1_700_000_000_000 } },
			{
				type: "message_end",
				message: { role: "assistant", timestamp: 1_700_000_000_000, content: [{ type: "text", text }] },
			},
		]);
		const appends = v2.flatMap((event) => v2ToPrimeSessionEvents(event));
		const cards = appends.filter((event) => event.type === "prime/card");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			type: "prime/card",
			data: { title: "EURUSD M5", payload },
		});
	});
});
