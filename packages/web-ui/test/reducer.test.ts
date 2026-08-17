import { describe, expect, it } from "vitest";
import { applyChat, applyChatDelta, applyThinking, type ChatMessage } from "../src/lib/reducer";

const user = (text: string, id = `u-${text}`): ChatMessage => ({
	type: "chat",
	role: "user",
	text,
	id,
	streaming: false,
});
const assistant = (text: string, id: string, streaming = false): ChatMessage => ({
	type: "chat",
	role: "assistant",
	text,
	id,
	streaming,
});

describe("applyChatDelta", () => {
	it("creates a streaming assistant message on first delta for an id", () => {
		const next = applyChatDelta([], "a1", "Hello");
		expect(next).toHaveLength(1);
		expect(next[0]).toEqual({ type: "chat", role: "assistant", text: "Hello", id: "a1", streaming: true });
	});

	it("accumulates subsequent deltas for the same id in order", () => {
		let next = applyChatDelta([], "a1", "Hello");
		next = applyChatDelta(next, "a1", " ");
		next = applyChatDelta(next, "a1", "world");
		expect(next).toHaveLength(1);
		expect(next[0].text).toBe("Hello world");
		expect(next[0].streaming).toBe(true);
	});

	it("keeps separate streaming buffers for distinct ids", () => {
		let next = applyChatDelta([], "a1", "one");
		next = applyChatDelta(next, "a2", "two");
		next = applyChatDelta(next, "a1", "!");
		expect(next.map((m) => [m.id, m.text])).toEqual([
			["a1", "one!"],
			["a2", "two"],
		]);
	});

	it("ignores empty deltas but still returns a new array reference", () => {
		const prev = [assistant("hi", "a1")];
		const next = applyChatDelta(prev, "a1", "");
		expect(next).toHaveLength(1);
		expect(next[0].text).toBe("hi");
	});

	it("caps the message list at MAX_MESSAGES, keeping the newest", () => {
		let next: ChatMessage[] = [];
		for (let i = 0; i < 210; i++) {
			next = applyChatDelta(next, `a${i}`, `t${i}`);
		}
		expect(next).toHaveLength(200);
		expect(next[0].id).toBe("a10");
		expect(next[199].id).toBe("a209");
	});
});

describe("applyChat", () => {
	it("replaces a streaming buffer with the finalized text and clears streaming", () => {
		const streaming = [assistant("Hello wor", "a1", true)];
		const next = applyChat(streaming, { type: "chat", role: "assistant", text: "Hello world", id: "a1" });
		expect(next).toHaveLength(1);
		expect(next[0].text).toBe("Hello world");
		expect(next[0].streaming).toBe(false);
	});

	it("appends a finalized assistant message with no matching id", () => {
		const next = applyChat([], { type: "chat", role: "assistant", text: "hi", id: "a1" });
		expect(next).toHaveLength(1);
		expect(next[0].streaming).toBe(false);
	});

	it("dedupes a server-echoed user message against the last optimistic user message", () => {
		const prev = [user("hello", "local-1")];
		const next = applyChat(prev, { type: "chat", role: "user", text: "hello", id: "echo-1" });
		expect(next).toHaveLength(1);
		expect(next[0].id).toBe("local-1");
	});

	it("does not dedupe when the last user message text differs", () => {
		const prev = [user("hello", "local-1")];
		const next = applyChat(prev, { type: "chat", role: "user", text: "other", id: "echo-2" });
		expect(next).toHaveLength(2);
	});

	it("does not dedupe when the last message is from the assistant", () => {
		const prev = [assistant("hi", "a1")];
		const next = applyChat(prev, { type: "chat", role: "user", text: "hi", id: "u-1" });
		expect(next).toHaveLength(2);
	});
});

describe("applyThinking", () => {
	it("stamps startedAt on first chunk and accumulates", () => {
		const blocks = applyThinking({}, "t1", "Planning.", false, 1000);
		expect(blocks.t1).toEqual({ id: "t1", text: "Planning.", done: false, startedAt: 1000 });
	});

	it("preserves startedAt across later chunks", () => {
		let blocks = applyThinking({}, "t1", "Planning.", false, 1000);
		blocks = applyThinking(blocks, "t1", " Done.", true, 2000);
		expect(blocks.t1.text).toBe("Planning. Done.");
		expect(blocks.t1.done).toBe(true);
		expect(blocks.t1.startedAt).toBe(1000);
	});
});
