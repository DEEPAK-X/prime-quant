/**
 * DSH client plugin entry (`@prime-quant/dsh-prime/client`, cordis row
 * `prime-client-nodes`). Registers the four prime/* ConversationNode
 * definitions and their keyed renderers behind `conversation.chat.node`.
 *
 * Registration order and keys follow the pinned 0.1.1-rc.2 bundled pattern:
 * `ctx.slots.inject(key, () => ctx.slots.register({ name, key }, Component))`.
 * No try/catch: a failed registration must surface at boot.
 */

import { createElement, type ReactElement } from "react";
import type { ChatConversationViewNode, ClientContext } from "./dsh-client.js";
import { cardDefinition, isPrimeCardData } from "./nodes/card.js";
import { stepDefinition, isPrimeStepData } from "./nodes/step.js";
import { tearsheetDefinition, isPrimeTearsheetData } from "./nodes/tearsheet.js";
import { subagentDefinition, isPrimeSubagentData } from "./nodes/subagent.js";
import { CardView } from "./views/CardView.js";
import { StepView } from "./views/StepView.js";
import { TearsheetView } from "./views/TearsheetView.js";
import { SubagentView } from "./views/SubagentView.js";

const CHAT_NODE_SLOT = "conversation.chat.node";

type NodeRenderer = (props: { readonly node: ChatConversationViewNode }) => ReactElement | null;

const cardRenderer: NodeRenderer = ({ node }) =>
	isPrimeCardData(node.data) ? createElement(CardView, { card: node.data }) : null;
const stepRenderer: NodeRenderer = ({ node }) =>
	isPrimeStepData(node.data) ? createElement(StepView, { step: node.data }) : null;
const tearsheetRenderer: NodeRenderer = ({ node }) =>
	isPrimeTearsheetData(node.data) ? createElement(TearsheetView, { tearsheet: node.data }) : null;
const subagentRenderer: NodeRenderer = ({ node }) =>
	isPrimeSubagentData(node.data) ? createElement(SubagentView, { subagent: node.data }) : null;

export function apply(ctx: ClientContext): void {
	ctx.conversationEvents.register(cardDefinition);
	ctx.conversationEvents.register(stepDefinition);
	ctx.conversationEvents.register(tearsheetDefinition);
	ctx.conversationEvents.register(subagentDefinition);

	ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({ name: CHAT_NODE_SLOT, key: "prime-card" }, cardRenderer));
	ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({ name: CHAT_NODE_SLOT, key: "prime-step" }, stepRenderer));
	ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({ name: CHAT_NODE_SLOT, key: "prime-tearsheet" }, tearsheetRenderer));
	ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({ name: CHAT_NODE_SLOT, key: "prime-subagent" }, subagentRenderer));
}
