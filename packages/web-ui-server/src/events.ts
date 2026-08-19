/**
 * GUI v2 contract event types (docs/gui-wiring/02-api-contract.md).
 *
 * These are the lowercase wire events broadcast over WS `/ws` and served
 * through the REST snapshot endpoints. Extensions are agreed in PLAN.md and
 * recorded in docs/gui-wiring/02-api-contract.md: the A2 rooms model adds
 * `room_message` and `rooms_state`, which older GUIs drop silently (their
 * `isServerEvent` guard ignores unknown event types).
 */

export type AgentState = "starting" | "ready" | "busy" | "error" | "stopped";

export interface Mt5Detail {
	server?: string;
	login?: number;
	symbols?: number;
}

export interface Mt5Status {
	status: "ok" | "down" | "unknown";
	detail: Mt5Detail | null;
	checkedAt: string | null;
}

export type SubagentStatus = "RUNNING" | "DONE" | "ERROR";

export type V2Event =
	| {
			type: "hello";
			protocol: 2;
			backend: "bridge" | "demo";
			agentState: AgentState;
			sessionId: string | null;
			mt5: Mt5Status;
			/** A2 rooms: known room ids at connect time. */
			rooms?: string[];
	  }
	| { type: "agent_state"; state: AgentState; detail?: string }
	| { type: "rooms_state"; rooms: Array<{ id: string; topic: string }> }
	| { type: "room_message"; room: string; id: string; from: string; text: string; ts: string }
	| { type: "chat"; role: "user" | "assistant"; text: string; id: string; ts: string }
	| { type: "chat_delta"; id: string; delta: string }
	| { type: "thinking"; id: string; delta: string; done: boolean }
	| { type: "step"; id: string; name: string; status: "running" | "done" | "error"; detail?: string }
	| {
			type: "subagent";
			id: string;
			name?: string;
			tier?: string;
			status: SubagentStatus;
			tokensPerMin?: number;
			task?: string;
	  }
	| { type: "tearsheet"; url: string; name?: string; ts?: string }
	| { type: "artifact"; kind: "py" | "mq5" | "md"; name: string; content: string }
	| { type: "card"; id: string; title: string; payload: Record<string, unknown> }
	| { type: "error"; scope: "agent" | "bridge" | "mt5" | "protocol"; message: string; fatal: boolean };
