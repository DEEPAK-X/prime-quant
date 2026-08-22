/**
 * Structural seam against the pinned DeepSeek Harness client SDK.
 *
 * The pinned client packages (`@deepseek-ai/*@0.1.1-rc.2`, the local
 * `dsh` install) are not resolvable from this workspace, so this module
 * mirrors — type-for-type, name-for-name — only the surfaces this plugin
 * consumes. Sources of truth, all verified in the pinned install:
 *
 * - SessionEvent envelope ........ @deepseek-ai/dsh-session/types types.d.ts
 * - ConversationNodeDefinition ... @deepseek-ai/dsh-client-runtime/client contract/conversation.d.ts
 * - ctx.conversationEvents ....... dsh-client-runtime conversation/event-registry.d.ts
 * - ctx.slots.inject/register .... dsh-client-runtime slots.d.ts + the bundled
 *                                  ui-conversation `registerChatNodeRenderers`
 * - keyed slot 'conversation.chat.node' / 'settings.plugin.item'
 *
 * Follow-up (dsh-contract): once DSH lands as a devDependency, delete this
 * module and import these names from the pinned packages directly.
 */

import type { ReactNode } from "react";

/** Envelope of one appended session event (`SessionEvent`, structurally). */
export interface PrimeSessionEvent {
	readonly type: string;
	readonly seq: number;
	readonly time: number;
	readonly data: unknown;
}

/** Definition-local identity and lifecycle role for one event. */
export interface ConversationMatchResult {
	readonly id: string;
	readonly role: "start" | "update";
}

/** Engine-owned placement of one matched event (payloads unused by views). */
export type ConversationLocation =
	| { readonly kind: "session" }
	| { readonly kind: "turn"; readonly turn: unknown }
	| { readonly kind: "step"; readonly turn: unknown; readonly step: unknown }
	| { readonly kind: "unresolved" };

/** One event accepted by a Definition, with its resolved location. */
export interface ConversationMatch {
	readonly event: PrimeSessionEvent;
	role: "start" | "update";
	readonly location: ConversationLocation;
}

/** Strictly-backward Context lookup available while a start is evaluated. */
export interface ConversationContextReader {
	previous(kind: string): { readonly startSeq: number; readonly state: unknown } | undefined;
}

/** Immutable public view of an assembled business Context. */
export interface ConversationNodeContext<State> {
	readonly key: string;
	readonly kind: string;
	readonly id: string;
	readonly matches: readonly ConversationMatch[];
	readonly start: ConversationMatch | undefined;
	readonly state: State | undefined;
}

/** Final Chat render unit produced by a business Definition. */
export interface ChatConversationViewNode {
	readonly key: string;
	readonly kind: string;
	readonly id: string;
	readonly target: "chat";
	readonly anchorSeq: number;
	readonly location: ConversationLocation;
	readonly visibility: "visible" | "hidden";
	readonly data: unknown;
}

/**
 * One independently registered Event-to-Node state machine. Mirrors the
 * pinned `ConversationNodeDefinition`; only members this plugin uses carry
 * full payloads.
 */
export interface ConversationNodeDefinition<State> {
	readonly kind: string;
	readonly target?: string;
	match(event: PrimeSessionEvent): ConversationMatchResult | null;
	start(context: ConversationNodeContext<State>, match: ConversationMatch, reader: ConversationContextReader): State;
	update(context: ConversationNodeContext<State> & { readonly state: State }, match: ConversationMatch): State;
	buildViewNode?(context: ConversationNodeContext<State>): ChatConversationViewNode | null;
}

/** Registration spec of a slot entry, as bundled built-ins pass it. */
export interface SlotRegistrationSpec {
	/** SlotMap key of the seat, e.g. "conversation.chat.node". */
	readonly name: string;
	/** Entry key inside a keyed seat: the renderer dispatch key. */
	readonly key: string;
}

/** Faces of the pinned client context this plugin touches. */
export interface ClientContext {
	readonly conversationEvents: {
		register<State>(definition: ConversationNodeDefinition<State>): () => void;
	};
	readonly slots: {
		inject(key: string, callback: () => () => void): () => void;
		/**
		 * Function components only: the pinned seat passes owner props plus the
		 * keyed `node` share; class-component `defaultProps` variance would make
		 * the wider ComponentType uninhabitable here.
		 */
		register(spec: SlotRegistrationSpec, component: (props: never) => ReactNode): () => void;
	};
}

/** Resolve the best currently loaded event Location of a Context. */
export function contextLocation(context: ConversationNodeContext<unknown>): ConversationLocation {
	return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
}

/** Build one final Chat node with the engine-owned stable key. */
export function chatViewNode<Data>(
	context: ConversationNodeContext<unknown>,
	kind: string,
	data: Data,
	options?: { readonly visibility?: "visible" | "hidden" },
): ChatConversationViewNode {
	return {
		key: context.key,
		kind,
		id: context.id,
		target: "chat",
		anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
		location: contextLocation(context),
		visibility: options?.visibility ?? "visible",
		data,
	};
}
