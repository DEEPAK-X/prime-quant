/**
 * RPC event → v2 contract event translation (docs/gui-wiring/03 §M2).
 *
 * The translator is stateful: it keeps an open assistant-message buffer per
 * streamed message so `message_end` can emit the final `chat` with the full
 * text, plus a step-id registry per tool execution instance
 * (`run-<n>-<stage>`, monotonic n).
 */

import type { SubagentStatus, V2Event } from "./events.js";
import { mapSessionEvent } from "./gui-bridge.js";

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

export interface CardSniffResult {
	title: string;
	payload: Record<string, unknown>;
}

export type CardSniffer = (text: string) => CardSniffResult | null;

export interface EventTranslatorOptions {
	/** Sniff complete assistant messages for quant JSON cards (wired in M3). */
	cardSniffer?: CardSniffer;
}

interface OpenMessage {
	id: string;
	thinkingId: string | null;
	sawThinking: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function iso(timestamp: unknown): string {
	return typeof timestamp === "number" ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function extractAssistantText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const record = asRecord(block);
			if (record && record.type === "text" && typeof record.text === "string") {
				parts.push(record.text);
			}
		}
		return parts.join("");
	}
	return "";
}

function resultText(result: unknown): string {
	const record = asRecord(result);
	if (!record) {
		return "";
	}
	if (typeof record.text === "string") {
		return record.text;
	}
	const content = record.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const item = asRecord(block);
			if (item && typeof item.text === "string") {
				parts.push(item.text);
			}
		}
		return parts.join("");
	}
	try {
		return JSON.stringify(result);
	} catch {
		return "";
	}
}

function summarizeResult(result: unknown): string {
	const text = resultText(result).trim();
	if (text.length <= 80) {
		return text;
	}
	return `${text.slice(0, 80)}…`;
}

/**
 * Derive the pipeline stage from an ipython cell's code. Order matters:
 * `run_pipeline` may contain `validate` and `optimize` internally, so the
 * most specific intent wins.
 */
export function deriveStage(code: string): string {
	if (code.includes("fetch_data")) return "fetch_data";
	if (code.includes("run_backtest")) return "backtest";
	if (code.includes("run_pipeline") || code.includes("validate") || code.includes("validation")) return "cpcv_gate";
	if (code.includes("optimize")) return "optimize";
	return "backtest";
}

export class EventTranslator {
	private messageSeq = 0;
	private thinkingSeq = 0;
	private stepSeq = 0;
	private cardSeq = 0;
	private openMessages: OpenMessage[] = [];
	private stepsByToolCallId = new Map<string, { id: string; name: string }>();
	private lastCompactionStepId: string | null = null;
	private readonly cardSniffer: CardSniffer | undefined;

	constructor(options: EventTranslatorOptions = {}) {
		this.cardSniffer = options.cardSniffer;
	}

	translate(record: RpcRecord): V2Event[] {
		switch (record.type) {
			case "agent_start":
				return [{ type: "agent_state", state: "busy" }];
			case "agent_end":
				return [{ type: "agent_state", state: "ready" }];
			case "message_start":
				return this.translateMessageStart(record);
			case "message_update":
				return this.translateMessageUpdate(record);
			case "message_end":
				return this.translateMessageEnd(record);
			case "tool_execution_start":
				return this.translateToolStart(record);
			case "tool_execution_end":
				return this.translateToolEnd(record);
			case "compaction_start":
				return this.translateCompactionStart();
			case "compaction_end":
				return this.translateCompactionEnd();
			case "response":
				return this.translateResponse(record);
			case "session_event":
				return this.translateSessionEvent(record);
			default:
				// tool_execution_update and anything else we don't model are ignored.
				return [];
		}
	}

	private translateMessageStart(record: RpcRecord): V2Event[] {
		const message = asRecord(record.message);
		if (!message || message.role !== "assistant") {
			// User/toolResult messages are echoed by the bridge itself; ignore.
			return [];
		}
		this.openMessages.push({ id: `msg-${++this.messageSeq}`, thinkingId: null, sawThinking: false });
		return [];
	}

	private translateMessageUpdate(record: RpcRecord): V2Event[] {
		const open = this.openMessages[this.openMessages.length - 1];
		if (!open) {
			return [];
		}
		const event = asRecord(record.assistantMessageEvent);
		if (!event) {
			return [];
		}
		const delta = asString(event.delta);
		if (delta === null) {
			return [];
		}
		switch (event.type) {
			case "text_delta":
				return [{ type: "chat_delta", id: open.id, delta }];
			case "thinking_delta": {
				if (!open.thinkingId) {
					open.thinkingId = `t-${++this.thinkingSeq}`;
				}
				open.sawThinking = true;
				return [{ type: "thinking", id: open.thinkingId, delta, done: false }];
			}
			default:
				return [];
		}
	}

	private translateMessageEnd(record: RpcRecord): V2Event[] {
		const open = this.openMessages.pop();
		if (!open) {
			return [];
		}
		const message = asRecord(record.message);
		const text = message ? extractAssistantText(message) : "";
		const events: V2Event[] = [];
		if (open.sawThinking && open.thinkingId) {
			events.push({ type: "thinking", id: open.thinkingId, delta: "", done: true });
		}
		events.push({ type: "chat", role: "assistant", text, id: open.id, ts: iso(message?.timestamp) });
		const sniffed = this.cardSniffer?.(text.trim());
		if (sniffed) {
			events.push({ type: "card", id: `c-${++this.cardSeq}`, title: sniffed.title, payload: sniffed.payload });
		}
		return events;
	}

	private translateToolStart(record: RpcRecord): V2Event[] {
		if (record.toolName !== "ipython") {
			return [];
		}
		const args = asRecord(record.args);
		const code = typeof args?.code === "string" ? args.code : "";
		const name = deriveStage(code);
		const id = `run-${++this.stepSeq}-${name}`;
		this.stepsByToolCallId.set(asString(record.toolCallId) ?? "", { id, name });
		return [{ type: "step", id, name, status: "running" }];
	}

	private translateToolEnd(record: RpcRecord): V2Event[] {
		const toolCallId = asString(record.toolCallId) ?? "";
		const step = this.stepsByToolCallId.get(toolCallId);
		if (!step) {
			return [];
		}
		this.stepsByToolCallId.delete(toolCallId);
		const isError = record.isError === true;
		const detail = summarizeResult(record.result);
		return [{ type: "step", id: step.id, name: step.name, status: isError ? "error" : "done", detail }];
	}

	private translateCompactionStart(): V2Event[] {
		const id = `run-${++this.stepSeq}-compaction`;
		this.lastCompactionStepId = id;
		return [{ type: "step", id, name: "compaction", status: "running" }];
	}

	private translateCompactionEnd(): V2Event[] {
		if (!this.lastCompactionStepId) {
			return [];
		}
		return [{ type: "step", id: this.lastCompactionStepId, name: "compaction", status: "done" }];
	}

	private translateResponse(record: RpcRecord): V2Event[] {
		if (record.success !== false) {
			return [];
		}
		const message =
			typeof record.error === "string" ? record.error : `RPC command failed: ${String(record.command ?? "unknown")}`;
		return [{ type: "error", scope: "agent", message, fatal: false }];
	}

	private translateSessionEvent(record: RpcRecord): V2Event[] {
		const mapped = mapSessionEvent(
			record as { type: string; event?: { type?: string; child?: Record<string, unknown> } },
		);
		if (!mapped) {
			return [];
		}
		const inner = asRecord(record.event);
		const child = inner ? asRecord(inner.child) : null;
		const childStatus = asString(child?.status) ?? "";
		switch (mapped.type) {
			case "SUBAGENT_SPAWNED":
				return [{ type: "subagent", id: mapped.id, tier: mapped.model_tier, status: "RUNNING", task: mapped.task }];
			case "SUBAGENT_PROGRESS":
				return [{ type: "subagent", id: mapped.id, status: "RUNNING", task: mapped.current_step }];
			case "SUBAGENT_COMPLETED": {
				const status: SubagentStatus = childStatus === "error" ? "ERROR" : "DONE";
				return [{ type: "subagent", id: mapped.id, status }];
			}
			default:
				return [];
		}
	}
}
