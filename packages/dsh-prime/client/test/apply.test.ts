import { describe, expect, it } from "vitest";
import type { ClientContext, ConversationNodeDefinition, PrimeSessionEvent } from "../dsh-client.js";
import { apply as applyChatNodes } from "../index.js";
import { apply as applySettings, PRIME_SETTINGS_NAMESPACE } from "../settings.js";
import { cardDefinition } from "../nodes/card.js";
import { stepDefinition } from "../nodes/step.js";
import { tearsheetDefinition } from "../nodes/tearsheet.js";
import { subagentDefinition } from "../nodes/subagent.js";

const ALL_DEFINITIONS: Array<ConversationNodeDefinition<unknown>> = [
	cardDefinition,
	stepDefinition,
	tearsheetDefinition,
	subagentDefinition,
];

interface FakeContext extends ClientContext {
	registeredKinds(): string[];
	slotEntries(): ReadonlyArray<{ readonly slot: string; readonly key: string }>;
}

function fakeContext(): FakeContext {
	const kinds: string[] = [];
	const entries: Array<{ slot: string; key: string }> = [];
	const context: FakeContext = {
		conversationEvents: {
			register(definition: ConversationNodeDefinition<unknown>) {
				kinds.push(definition.kind);
				return () => undefined;
			},
		},
		slots: {
			inject(key, callback) {
				void key;
				callback();
				return () => undefined;
			},
			register(spec) {
				entries.push({ slot: spec.name, key: spec.key });
				return () => undefined;
			},
		},
		registeredKinds: () => kinds,
		slotEntries: () => entries,
	};
	return context;
}

describe("apply(ctx) chat-node wiring", () => {
	const ctx = fakeContext();
	applyChatNodes(ctx);

	it("registers the four prime definitions without swallowing failures", () => {
		expect(ctx.registeredKinds()).toEqual(["prime-card", "prime-step", "prime-tearsheet", "prime-subagent"]);
	});

	it("injects one renderer per kind behind conversation.chat.node", () => {
		expect(ctx.slotEntries()).toEqual([
			{ slot: "conversation.chat.node", key: "prime-card" },
			{ slot: "conversation.chat.node", key: "prime-step" },
			{ slot: "conversation.chat.node", key: "prime-tearsheet" },
			{ slot: "conversation.chat.node", key: "prime-subagent" },
		]);
	});
});

describe("apply(ctx) settings wiring", () => {
	const ctx = fakeContext();
	applySettings(ctx);

	it("contributes exactly one plugin card under the prime-agent namespace", () => {
		expect(ctx.slotEntries()).toEqual([{ slot: "settings.plugin.item", key: PRIME_SETTINGS_NAMESPACE }]);
	});
});

describe("registered definitions accept contract events", () => {
	const cardEvent: PrimeSessionEvent = {
		type: "prime/card",
		seq: 1,
		time: 0,
		data: { cardId: "c1", title: "T", payload: { status: "success", validation_gate: { passed: true } } },
	};

	it("the card definition matches, folds, and builds a visible node", () => {
		const matched = cardDefinition.match(cardEvent);
		expect(matched).toEqual({ id: "c1", role: "start" });
		const state = cardDefinition.start(
			{ key: "k", kind: cardDefinition.kind, id: "c1", matches: [], start: undefined, state: undefined },
			{ event: cardEvent, role: "start", location: { kind: "unresolved" } },
			{ previous: () => undefined },
		);
		expect(state?.payload).toBeDefined();
		const node = cardDefinition.buildViewNode?.({
			key: "k",
			kind: cardDefinition.kind,
			id: "c1",
			matches: [],
			start: undefined,
			state,
		});
		expect(node?.visibility).toBe("visible");
	});

	it("every definition kind is covered by the wiring test set", () => {
		expect(ALL_DEFINITIONS.map((definition) => definition.kind)).toEqual([
			"prime-card",
			"prime-step",
			"prime-tearsheet",
			"prime-subagent",
		]);
	});
});
