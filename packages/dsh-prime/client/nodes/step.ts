/**
 * prime/step node: one pipeline chip per stepId (docs/dsh-adapter/02 §5.2).
 * `running` starts the Context, later statuses update it; last status wins.
 */

import type {
	ChatConversationViewNode,
	ConversationMatchResult,
	ConversationNodeDefinition,
	PrimeSessionEvent,
} from "../dsh-client.js";
import { chatViewNode } from "../dsh-client.js";
import { recordOf, stringField } from "../lib/narrow.js";

export type PrimeStepStatus = "running" | "done" | "error";

export interface PrimeStepRecord {
	readonly stepId: string;
	readonly name: string;
	readonly status: PrimeStepStatus;
	readonly detail: string | undefined;
}

function statusOf(value: unknown): PrimeStepStatus | undefined {
	return value === "running" || value === "done" || value === "error" ? value : undefined;
}

export function matchStep(event: PrimeSessionEvent): ConversationMatchResult | null {
	if (event.type !== "prime/step") return null;
	const data = recordOf(event.data);
	const stepId = stringField(data, "stepId");
	if (stepId === undefined) return null;
	return { id: stepId, role: data?.status === "running" ? "start" : "update" };
}

/** Single-record reducer: last event for a stepId wins. */
export function foldStepRecord(
	previous: PrimeStepRecord | undefined,
	event: PrimeSessionEvent,
): PrimeStepRecord | undefined {
	if (event.type !== "prime/step") return previous;
	const data = recordOf(event.data);
	const stepId = stringField(data, "stepId");
	if (stepId === undefined || (previous !== undefined && previous.stepId !== stepId)) return previous;
	return {
		stepId,
		name: stringField(data, "name") ?? previous?.name ?? stepId,
		status: statusOf(data?.status) ?? previous?.status ?? "running",
		detail: stringField(data, "detail") ?? previous?.detail,
	};
}

/** Upsert by stepId into a transcript-level collection. */
export function foldStep(
	steps: ReadonlyMap<string, PrimeStepRecord>,
	event: PrimeSessionEvent,
): ReadonlyMap<string, PrimeStepRecord> {
	if (event.type !== "prime/step") return steps;
	const next = foldStepRecord(steps.get(stringField(recordOf(event.data), "stepId") ?? ""), event);
	if (next === undefined) return steps;
	const merged = new Map(steps);
	merged.set(next.stepId, next);
	return merged;
}

export const stepDefinition: ConversationNodeDefinition<PrimeStepRecord | undefined> = {
	kind: "prime-step",
	target: "chat",
	match: matchStep,
	start: (_context, match) => foldStepRecord(undefined, match.event),
	update: (context, match) => foldStepRecord(context.state, match.event),
	buildViewNode: (context): ChatConversationViewNode | null => {
		const state = context.state;
		return state === undefined ? null : chatViewNode(context, "prime-step", state);
	},
};

/** Narrow a view-node payload back to its record (engine guarantees origin). */
export function isPrimeStepData(data: unknown): data is PrimeStepRecord {
	const record = recordOf(data);
	return typeof record?.stepId === "string" && typeof record?.name === "string";
}
