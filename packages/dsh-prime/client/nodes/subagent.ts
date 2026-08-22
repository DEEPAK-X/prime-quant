/**
 * prime/subagent node: Prime worker status row (docs/dsh-adapter/02 §5.4).
 * Upsert by id; RUNNING starts the Context, DONE/ERROR update it.
 */

import type {
	ChatConversationViewNode,
	ConversationMatchResult,
	ConversationNodeDefinition,
	PrimeSessionEvent,
} from "../dsh-client.js";
import { chatViewNode } from "../dsh-client.js";
import { recordOf, stringField } from "../lib/narrow.js";

export type PrimeSubagentStatus = "RUNNING" | "DONE" | "ERROR";

export interface PrimeSubagentRecord {
	readonly id: string;
	readonly name: string;
	readonly tier: string | undefined;
	readonly status: PrimeSubagentStatus;
	readonly task: string | undefined;
}

function statusOf(value: unknown): PrimeSubagentStatus | undefined {
	return value === "RUNNING" || value === "DONE" || value === "ERROR" ? value : undefined;
}

export function matchSubagent(event: PrimeSessionEvent): ConversationMatchResult | null {
	if (event.type !== "prime/subagent") return null;
	const data = recordOf(event.data);
	const id = stringField(data, "id");
	if (id === undefined) return null;
	return { id, role: data?.status === "RUNNING" ? "start" : "update" };
}

/** Single-record reducer: last event for an id wins. */
export function foldSubagentRecord(
	previous: PrimeSubagentRecord | undefined,
	event: PrimeSessionEvent,
): PrimeSubagentRecord | undefined {
	if (event.type !== "prime/subagent") return previous;
	const data = recordOf(event.data);
	const id = stringField(data, "id");
	if (id === undefined || (previous !== undefined && previous.id !== id)) return previous;
	return {
		id,
		name: stringField(data, "name") ?? previous?.name ?? id,
		tier: stringField(data, "tier") ?? previous?.tier,
		status: statusOf(data?.status) ?? previous?.status ?? "RUNNING",
		task: stringField(data, "task") ?? previous?.task,
	};
}

/** Upsert by id into a transcript-level collection. */
export function foldSubagent(
	subagents: ReadonlyMap<string, PrimeSubagentRecord>,
	event: PrimeSessionEvent,
): ReadonlyMap<string, PrimeSubagentRecord> {
	if (event.type !== "prime/subagent") return subagents;
	const next = foldSubagentRecord(subagents.get(stringField(recordOf(event.data), "id") ?? ""), event);
	if (next === undefined) return subagents;
	const merged = new Map(subagents);
	merged.set(next.id, next);
	return merged;
}

export const subagentDefinition: ConversationNodeDefinition<PrimeSubagentRecord | undefined> = {
	kind: "prime-subagent",
	target: "chat",
	match: matchSubagent,
	start: (_context, match) => foldSubagentRecord(undefined, match.event),
	update: (context, match) => foldSubagentRecord(context.state, match.event),
	buildViewNode: (context): ChatConversationViewNode | null => {
		const state = context.state;
		return state === undefined ? null : chatViewNode(context, "prime-subagent", state);
	},
};

/** Narrow a view-node payload back to its record (engine guarantees origin). */
export function isPrimeSubagentData(data: unknown): data is PrimeSubagentRecord {
	const record = recordOf(data);
	return typeof record?.id === "string";
}
