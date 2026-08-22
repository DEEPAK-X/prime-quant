import { basename } from "node:path";

import type { V2Event } from "@earendil-works/pi-web-ui-server";

import type { PrimeSessionAppend } from "../prime-events.js";

const PRIME_REPORTS_PREFIX = "/prime-reports/";
const BRIDGE_REPORTS_PREFIX = "/reports/";

export function rewriteTearsheetUrl(url: string, name?: string): { url: string; name?: string } {
	const file = name && name.length > 0 ? basename(name.replace(/\\/g, "/")) : tearsheetBasename(url);
	return { url: `${PRIME_REPORTS_PREFIX}${file}`, name: name ?? file };
}

/**
 * Map one GUI v2 event to zero or more DSH SessionEvent appends (docs/dsh-adapter/03 A1).
 * Unknown v2 types → []. User chat is dropped. thinking is skipped (no pinned native event).
 */
export function v2ToPrimeSessionEvents(event: V2Event): PrimeSessionAppend[] {
	switch (event.type) {
		case "chat_delta":
			return [{ type: "assistant/chunk", data: { id: event.id, delta: event.delta } }];
		case "chat":
			if (event.role === "user") return [];
			return [{ type: "assistant/message", data: { id: event.id, text: event.text, ts: event.ts } }];
		case "step":
			return [
				{
					type: "prime/step",
					data: {
						stepId: event.id,
						name: event.name,
						status: event.status,
						...(event.detail ? { detail: event.detail } : {}),
					},
				},
			];
		case "card":
			return [{ type: "prime/card", data: { cardId: event.id, title: event.title, payload: event.payload } }];
		case "tearsheet": {
			const rewritten = rewriteTearsheetUrl(event.url, event.name);
			return [
				{
					type: "prime/tearsheet",
					data: {
						url: rewritten.url,
						...(rewritten.name ? { name: rewritten.name } : {}),
						...(event.ts ? { ts: event.ts } : {}),
					},
				},
			];
		}
		case "subagent":
			return [
				{
					type: "prime/subagent",
					data: {
						id: event.id,
						status: event.status,
						...(event.name ? { name: event.name } : {}),
						...(event.tier ? { tier: event.tier } : {}),
						...(event.task ? { task: event.task } : {}),
					},
				},
			];
		case "thinking":
		case "agent_state":
		case "hello":
		case "error":
		case "rooms_state":
		case "room_message":
		case "artifact":
			return [];
	}
}

/** Strip a `/reports/` prefix so rewriteTearsheetUrl still works if the v2 url is already prefixed. */
export function tearsheetBasename(url: string): string {
	let path = url;
	if (path.startsWith(BRIDGE_REPORTS_PREFIX)) path = path.slice(BRIDGE_REPORTS_PREFIX.length);
	if (path.startsWith(PRIME_REPORTS_PREFIX)) path = path.slice(PRIME_REPORTS_PREFIX.length);
	return basename(path.replace(/\\/g, "/"));
}

export const PRIME_REPORTS_PATH = PRIME_REPORTS_PREFIX;
