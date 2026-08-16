/**
 * PrimeQuant GUI v2 contract (mirrors docs/gui-wiring/02-api-contract.md).
 *
 * Single source of truth for every event/object crossing the bridge<->GUI
 * boundary. Both the socket store (ws.ts) and the mock-socket fixture
 * replay (mock-socket.ts) consume these types so the demo (protocol v1)
 * and the real bridge (protocol v2) share one reducer.
 *
 * v1 demo events (chat/step/subagent/tearsheet/artifact) are a strict subset
 * of the v2 shapes: the store accepts them unchanged and simply never sees
 * hello/chat_delta/thinking/card/agent_state, which is how it detects demo
 * mode (no `hello` with protocol 2 within 2s of connect).
 */

export type Protocol = 1 | 2;
export type Backend = "bridge" | "demo";

export type AgentState = "starting" | "ready" | "busy" | "error" | "stopped";
export type ConnectionState = "connecting" | "open" | "closed";

/** Known pipeline step names; the bridge may emit others (rendered title-cased). */
export type KnownStepName = "ast_check" | "backtest" | "cpcv_gate" | "optimize" | "tearsheet" | "fetch_data";

export type StepStatus = "running" | "done" | "error";
export type SubagentStatus = "RUNNING" | "DONE" | "ERROR";
export type ArtifactKind = "py" | "mq5" | "md";
export type ErrorScope = "agent" | "bridge" | "mt5" | "protocol";

export interface Mt5Detail {
	readonly server?: string;
	readonly login?: number;
	readonly symbols?: number;
}

export interface Mt5State {
	readonly status: "ok" | "down" | "unknown";
	readonly detail: Mt5Detail | null;
	readonly checkedAt?: string;
}

export interface HelloEvent {
	readonly type: "hello";
	readonly protocol: Protocol;
	readonly backend: Backend;
	readonly agentState: AgentState;
	readonly sessionId: string | null;
	readonly mt5: Mt5State;
}

export interface AgentStateEvent {
	readonly type: "agent_state";
	readonly state: AgentState;
	readonly detail?: string;
}

export interface ChatEvent {
	readonly type: "chat";
	readonly role: "user" | "assistant";
	readonly text: string;
	readonly id?: string;
	readonly ts?: string;
}

export interface ChatDeltaEvent {
	readonly type: "chat_delta";
	readonly id: string;
	readonly delta: string;
}

export interface ThinkingEvent {
	readonly type: "thinking";
	readonly id: string;
	readonly delta: string;
	readonly done: boolean;
}

export interface StepEvent {
	readonly type: "step";
	readonly id: string;
	readonly name: string;
	readonly status: StepStatus;
	readonly detail?: string;
}

export interface SubagentEvent {
	readonly type: "subagent";
	readonly id: string;
	readonly name: string;
	readonly tier: string;
	readonly status: SubagentStatus;
	readonly tokensPerMin?: number;
	readonly task?: string;
}

export interface TearsheetEvent {
	readonly type: "tearsheet";
	readonly url: string;
	readonly name?: string;
	readonly ts?: string;
}

export interface ArtifactEvent {
	readonly type: "artifact";
	readonly kind: ArtifactKind;
	readonly name: string;
	readonly content: string;
}

export interface CardMetric {
	readonly [label: string]: number | string | boolean | null;
}

export interface ValidationGate {
	readonly passed?: boolean;
	readonly [label: string]: number | string | boolean | null | undefined;
}

export interface CardPayload {
	readonly status?: string;
	readonly metrics?: CardMetric;
	readonly validation_gate?: ValidationGate;
	readonly [label: string]: unknown;
}

export interface CardEvent {
	readonly type: "card";
	readonly id: string;
	readonly title: string;
	readonly payload: CardPayload;
}

export interface ErrorEvent {
	readonly type: "error";
	readonly scope: ErrorScope;
	readonly message: string;
	readonly fatal: boolean;
}

/** Union of every server->client event the GUI must handle. */
export type ServerEvent =
	| HelloEvent
	| AgentStateEvent
	| ChatEvent
	| ChatDeltaEvent
	| ThinkingEvent
	| StepEvent
	| SubagentEvent
	| TearsheetEvent
	| ArtifactEvent
	| CardEvent
	| ErrorEvent;

/** Client->server messages. */
export type ClientMessage =
	| { readonly type: "chat"; readonly text: string }
	| { readonly type: "interrupt" }
	| { readonly type: "refresh_mt5" };

export interface ArtifactStore {
	readonly py: ArtifactEvent[];
	readonly mq5: ArtifactEvent[];
	readonly md: ArtifactEvent[];
}

export interface TearsheetEntry {
	readonly url: string;
	readonly name?: string;
	readonly ts?: string;
}

/**
 * Runtime guard: the demo backend emits untyped JSON over the wire, so every
 * frame is validated before it reaches the reducer. Unknown event types are
 * dropped silently (forward-compat with bridge additions).
 */
export function isServerEvent(value: unknown): value is ServerEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Record<string, unknown>;
	switch (event.type) {
		case "hello":
			return event.protocol === 1 || event.protocol === 2;
		case "agent_state":
			return typeof event.state === "string";
		case "chat":
			return event.role === "user" || event.role === "assistant";
		case "chat_delta":
			return typeof event.id === "string" && typeof event.delta === "string";
		case "thinking":
			return typeof event.id === "string" && typeof event.delta === "string" && typeof event.done === "boolean";
		case "step":
			return typeof event.id === "string" && typeof event.name === "string" && typeof event.status === "string";
		case "subagent":
			return typeof event.id === "string" && typeof event.name === "string" && typeof event.status === "string";
		case "tearsheet":
			return typeof event.url === "string";
		case "artifact":
			return (
				(event.kind === "py" || event.kind === "mq5" || event.kind === "md") && typeof event.content === "string"
			);
		case "card":
			return typeof event.id === "string" && typeof event.title === "string";
		case "error":
			return typeof event.message === "string" && typeof event.fatal === "boolean";
		default:
			return false;
	}
}

export function upsertSubagent(
	existing: Record<string, SubagentEvent>,
	event: SubagentEvent,
): Record<string, SubagentEvent> {
	return { ...existing, [event.id]: event };
}

export function upsertArtifact(list: readonly ArtifactEvent[], event: ArtifactEvent): ArtifactEvent[] {
	return [...list.filter((entry) => entry.name !== event.name), event];
}

export function emptyArtifactStore(): ArtifactStore {
	return { py: [], mq5: [], md: [] };
}
