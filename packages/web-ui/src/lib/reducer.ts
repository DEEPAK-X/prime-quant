/**
 * Pure chat-stream reducer helpers.
 *
 * Extracted from the React hook so the delta accumulator can be unit-tested
 * without a DOM: these functions take immutable state and return immutable
 * state, no side effects. The store (ws.ts) calls them inside setState
 * updaters; the rAF batcher coalesces many chat_delta frames into one call.
 */
import type { ChatEvent } from "./contract";

export interface ChatMessage extends ChatEvent {
	/** True while chat_delta frames for this id are still arriving. */
	readonly streaming: boolean;
}

export interface ThinkingBlock {
	readonly id: string;
	readonly text: string;
	readonly done: boolean;
	readonly startedAt: number;
}

export const MAX_MESSAGES = 200;

/**
 * Apply one accumulated delta chunk for a streaming assistant message.
 * If no message with the id exists, a new streaming assistant message is
 * created; otherwise the delta is appended. A finalized `chat` with the same
 * id later replaces the whole buffer (see applyChat).
 */
export function applyChatDelta(messages: readonly ChatMessage[], id: string, delta: string): ChatMessage[] {
	if (!delta) return [...messages];
	const index = messages.findIndex((message) => message.id === id);
	if (index === -1) {
		const created: ChatMessage = { type: "chat", role: "assistant", text: delta, id, streaming: true };
		const next = [...messages, created];
		return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
	}
	const updated: ChatMessage = { ...messages[index], text: messages[index].text + delta, streaming: true };
	return [...messages.slice(0, index), updated, ...messages.slice(index + 1)];
}

/**
 * Apply a finalized `chat` event. User messages echoed from the server are
 * deduped against the last optimistic user message with identical text (v1
 * behavior). A finalized assistant chat with an id replaces the streaming
 * buffer for that id; otherwise it appends.
 */
export function applyChat(messages: readonly ChatMessage[], event: ChatEvent): ChatMessage[] {
	if (event.role === "user" && messages.length > 0) {
		const last = messages[messages.length - 1];
		if (last.role === "user" && last.text === event.text) return [...messages];
	}
	const withId = event.id ? messages.findIndex((message) => message.id === event.id) : -1;
	if (withId !== -1) {
		const replaced = { ...messages[withId], text: event.text, streaming: false };
		return [...messages.slice(0, withId), replaced, ...messages.slice(withId + 1)];
	}
	const next = [...messages, { ...event, streaming: false }];
	return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

/** Accumulate a thinking delta; stamps startedAt on first chunk, flips done on final. */
export function applyThinking(
	blocks: Readonly<Record<string, ThinkingBlock>>,
	id: string,
	delta: string,
	done: boolean,
	now: number = Date.now(),
): Record<string, ThinkingBlock> {
	const existing = blocks[id];
	const text = (existing?.text ?? "") + delta;
	return { ...blocks, [id]: { id, text, done, startedAt: existing?.startedAt ?? now } };
}
