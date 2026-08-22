/**
 * prime/card node: quant result card (docs/dsh-adapter/02 §5.1).
 * Payload is the GUI v2 card payload; rendering lives in views/CardView.tsx.
 */

import type {
	ChatConversationViewNode,
	ConversationMatchResult,
	ConversationNodeContext,
	ConversationNodeDefinition,
	PrimeSessionEvent,
} from "../dsh-client.js";
import { chatViewNode } from "../dsh-client.js";
import { recordOf, stringField } from "../lib/narrow.js";

export interface PrimeCardRecord {
	readonly cardId: string;
	readonly title: string;
	readonly payload: Record<string, unknown>;
}

export function matchCard(event: PrimeSessionEvent): ConversationMatchResult | null {
	if (event.type !== "prime/card") return null;
	const cardId = stringField(recordOf(event.data), "cardId");
	if (cardId === undefined) return null;
	return { id: cardId, role: "start" };
}

/** Last write wins for a repeated cardId. */
export function foldCard(previous: PrimeCardRecord | undefined, event: PrimeSessionEvent): PrimeCardRecord | undefined {
	if (event.type !== "prime/card") return previous;
	const data = recordOf(event.data);
	const cardId = stringField(data, "cardId");
	if (cardId === undefined || (previous !== undefined && previous.cardId !== cardId)) return previous;
	return {
		cardId,
		title: stringField(data, "title") ?? previous?.title ?? cardId,
		payload: recordOf(data?.payload) ?? previous?.payload ?? {},
	};
}

export const cardDefinition: ConversationNodeDefinition<PrimeCardRecord | undefined> = {
	kind: "prime-card",
	target: "chat",
	match: matchCard,
	start: (_context, match) => foldCard(undefined, match.event),
	update: (context, match) => foldCard(context.state, match.event),
	buildViewNode: (context: ConversationNodeContext<PrimeCardRecord | undefined>): ChatConversationViewNode | null => {
		const state = context.state;
		return state === undefined ? null : chatViewNode(context, "prime-card", state);
	},
};

/** Narrow a view-node payload back to its record (engine guarantees origin). */
export function isPrimeCardData(data: unknown): data is PrimeCardRecord {
	return typeof recordOf(data)?.cardId === "string";
}
