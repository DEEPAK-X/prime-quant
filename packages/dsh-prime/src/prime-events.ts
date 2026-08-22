/**
 * Prime-specific SessionEvent payloads (docs/dsh-adapter/02 §5).
 * Agent B type-imports this file. Do not add extra event types without a
 * dsh-contract: issue.
 */

export type PrimeStepName = "ast_check" | "backtest" | "cpcv_gate" | "optimize" | "tearsheet" | "fetch_data" | string;

export type PrimeStepStatus = "running" | "done" | "error";

export type PrimeSubagentRunStatus = "RUNNING" | "DONE" | "ERROR";

export type PrimeMt5Health = "ok" | "down" | "unknown";

export interface PrimeCardData {
	cardId: string;
	title: string;
	payload: Record<string, unknown>;
}

export interface PrimeStepData {
	stepId: string;
	name: PrimeStepName;
	status: PrimeStepStatus;
	detail?: string;
}

export interface PrimeTearsheetData {
	url: string;
	name?: string;
	ts?: string;
}

export interface PrimeSubagentData {
	id: string;
	name?: string;
	tier?: string;
	status: PrimeSubagentRunStatus;
	task?: string;
}

export interface PrimeMt5Detail {
	server?: string;
	login?: number;
	symbols?: number;
}

export interface PrimeMt5Data {
	status: PrimeMt5Health;
	detail: PrimeMt5Detail | null;
	checkedAt: string | null;
}

export type PrimeCardEvent = { type: "prime/card"; data: PrimeCardData };
export type PrimeStepEvent = { type: "prime/step"; data: PrimeStepData };
export type PrimeTearsheetEvent = { type: "prime/tearsheet"; data: PrimeTearsheetData };
export type PrimeSubagentEvent = { type: "prime/subagent"; data: PrimeSubagentData };
export type PrimeMt5Event = { type: "prime/mt5"; data: PrimeMt5Data };

/** Native-shaped assistant streaming. Names follow 02 §5 / DSH assistant/* . */
export type AssistantChunkEvent = { type: "assistant/chunk"; data: { id: string; delta: string } };
export type AssistantMessageEvent = {
	type: "assistant/message";
	data: { id: string; text: string; ts: string };
};

export type PrimeSessionAppend =
	| AssistantChunkEvent
	| AssistantMessageEvent
	| PrimeCardEvent
	| PrimeStepEvent
	| PrimeTearsheetEvent
	| PrimeSubagentEvent
	| PrimeMt5Event;
