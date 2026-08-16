import { describe, expect, it } from "vitest";
import type { V2Event } from "../src/events.js";
import { deriveStage, EventTranslator, type RpcRecord } from "../src/translator.js";

function translateAll(
	records: RpcRecord[],
	cardSniffer?: (text: string) => { title: string; payload: Record<string, unknown> } | null,
): V2Event[] {
	const translator = new EventTranslator({ cardSniffer });
	const events: V2Event[] = [];
	for (const record of records) {
		events.push(...translator.translate(record));
	}
	return events;
}

const assistantMessageStart = {
	type: "message_start",
	message: { role: "assistant", timestamp: 1_700_000_000_000 },
} satisfies RpcRecord;

const assistantMessageEnd = {
	type: "message_end",
	message: { role: "assistant", timestamp: 1_700_000_000_000, content: [{ type: "text", text: "Final text" }] },
} satisfies RpcRecord;

describe("EventTranslator mapping table", () => {
	it("maps agent_start / agent_end to agent_state busy / ready", () => {
		const events = translateAll([{ type: "agent_start" }, { type: "agent_end" }]);
		expect(events).toEqual([
			{ type: "agent_state", state: "busy" },
			{ type: "agent_state", state: "ready" },
		]);
	});

	it("streams chat_delta and thinking, then a final chat with the full text", () => {
		const events = translateAll([
			assistantMessageStart,
			{ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "Fin" } },
			{ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
			{ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "al" } },
			{ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: " more" } },
			assistantMessageEnd,
		]);

		const deltas = events.filter(
			(event): event is Extract<V2Event, { type: "chat_delta" }> => event.type === "chat_delta",
		);
		expect(deltas.map((delta) => delta.delta)).toEqual(["Fin", "al"]);
		const thinking = events.filter(
			(event): event is Extract<V2Event, { type: "thinking" }> => event.type === "thinking",
		);
		expect(thinking.map((t) => ({ delta: t.delta, done: t.done }))).toEqual([
			{ delta: "hmm", done: false },
			{ delta: " more", done: false },
			{ delta: "", done: true },
		]);
		expect(thinking[0]!.id).toBe(thinking[1]!.id);
		const chat = events.filter(
			(event): event is Extract<V2Event, { type: "chat" }> => event.type === "chat" && event.role === "assistant",
		);
		expect(chat).toHaveLength(1);
		expect(chat[0]).toMatchObject({ role: "assistant", text: "Final text" });
		// chat_delta ids match the final chat id; the final chat arrives after all deltas.
		expect(deltas[0]!.id).toBe(chat[0]!.id);
		expect(events[events.length - 1]).toMatchObject({ type: "chat", role: "assistant" });
	});

	it("ignores user message_start records (the bridge echoes user chats itself)", () => {
		const events = translateAll([{ type: "message_start", message: { role: "user", timestamp: 1 } }]);
		expect(events).toEqual([]);
	});

	it("derives step stages from ipython cell code", () => {
		expect(deriveStage("card = await rlm.quant.fetch_data('EURUSD','M5',bars=5000)")).toBe("fetch_data");
		expect(deriveStage("card = await rlm.quant.run_backtest('sma cross')")).toBe("backtest");
		expect(deriveStage("await rlm.quant.run_pipeline('sma cross', report_path='t.html')")).toBe("cpcv_gate");
		expect(deriveStage("gate = run_validation_pipeline(spec, result)")).toBe("cpcv_gate");
		expect(deriveStage("best = optimizer.optimize(spec)")).toBe("optimize");
		expect(deriveStage("print('anything else')")).toBe("backtest");
	});

	it("emits one step per tool execution with monotonic run ids and a done/error end", () => {
		const events = translateAll([
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "ipython",
				args: { code: "await rlm.quant.run_pipeline('x')" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "ipython",
				result: { content: [{ type: "text", text: "dsr 1.32 · pbo 0.11" }] },
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "call-2",
				toolName: "ipython",
				args: { code: "await rlm.quant.fetch_data('EURUSD')" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call-2",
				toolName: "ipython",
				result: { content: [{ type: "text", text: "connection failed" }] },
				isError: true,
			},
		]);

		expect(events).toEqual([
			{ type: "step", id: "run-1-cpcv_gate", name: "cpcv_gate", status: "running" },
			{ type: "step", id: "run-1-cpcv_gate", name: "cpcv_gate", status: "done", detail: "dsr 1.32 · pbo 0.11" },
			{ type: "step", id: "run-2-fetch_data", name: "fetch_data", status: "running" },
			{ type: "step", id: "run-2-fetch_data", name: "fetch_data", status: "error", detail: "connection failed" },
		]);
	});

	it("truncates step detail to 80 characters", () => {
		const events = translateAll([
			{ type: "tool_execution_start", toolCallId: "c", toolName: "ipython", args: { code: "x" } },
			{
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "ipython",
				result: { content: [{ type: "text", text: "y".repeat(200) }] },
				isError: false,
			},
		]);
		const done = events.find((event) => event.type === "step" && event.status === "done");
		expect(done && "detail" in done ? (done.detail ?? "").length : -1).toBe(81); // 80 chars + ellipsis
	});

	it("ignores non-ipython tools and tool_execution_update", () => {
		const events = translateAll([
			{ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "ls" } },
			{ type: "tool_execution_update", toolCallId: "c", toolName: "ipython", partialResult: {} },
			{ type: "tool_execution_end", toolCallId: "unknown", toolName: "ipython", result: {}, isError: false },
		]);
		expect(events).toEqual([]);
	});

	it("maps compaction start/end to a paired step", () => {
		const events = translateAll([
			{ type: "compaction_start", reason: "threshold" },
			{ type: "compaction_end", reason: "threshold" },
		]);
		expect(events).toEqual([
			{ type: "step", id: "run-1-compaction", name: "compaction", status: "running" },
			{ type: "step", id: "run-1-compaction", name: "compaction", status: "done" },
		]);
	});

	it("maps failed responses to agent errors", () => {
		const events = translateAll([
			{ type: "response", command: "prompt", success: false, error: "model not configured" },
		]);
		expect(events).toEqual([{ type: "error", scope: "agent", message: "model not configured", fatal: false }]);
		// Successful responses produce nothing.
		expect(translateAll([{ type: "response", command: "get_state", success: true }])).toEqual([]);
	});

	it("maps rlm_child_update session events to subagent events", () => {
		const running = translateAll([
			{
				type: "session_event",
				event: {
					type: "rlm_child_update",
					child: { id: "child-1", status: "running", label: "Run sweep", model: "tier:worker" },
				},
			},
		]);
		expect(running).toEqual([
			{ type: "subagent", id: "child-1", tier: "worker", status: "RUNNING", task: "Run sweep" },
		]);

		const done = translateAll([
			{
				type: "session_event",
				event: {
					type: "rlm_child_update",
					child: { id: "child-1", status: "done", answerPreview: '{"status":"ok"}' },
				},
			},
		]);
		expect(done).toEqual([{ type: "subagent", id: "child-1", status: "DONE" }]);

		const errored = translateAll([
			{
				type: "session_event",
				event: { type: "rlm_child_update", child: { id: "child-1", status: "error", label: "boom" } },
			},
		]);
		expect(errored).toEqual([{ type: "subagent", id: "child-1", status: "ERROR" }]);

		// Unrelated session events pass through as nothing.
		expect(translateAll([{ type: "session_event", event: { type: "connection_status" } }])).toEqual([]);
	});

	it("emits a card right after the chat when the sniffer detects a quant card", () => {
		const cardText = JSON.stringify({
			status: "success",
			metrics: { sharpe_ratio: 1.84 },
			validation_gate: { passed: true },
		});
		const events = translateAll(
			[
				{ type: "message_start", message: { role: "assistant", timestamp: 1_700_000_000_000 } },
				{
					type: "message_end",
					message: {
						role: "assistant",
						timestamp: 1_700_000_000_000,
						content: [{ type: "text", text: cardText }],
					},
				},
			],
			(text) => ({ title: "Result", payload: JSON.parse(text) as Record<string, unknown> }),
		);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "chat", role: "assistant" });
		expect(events[1]).toMatchObject({
			type: "card",
			title: "Result",
			payload: { status: "success", metrics: { sharpe_ratio: 1.84 } },
		});
	});
});
