/**
 * prime/tearsheet node: sandboxed report iframe (docs/dsh-adapter/02 §5.3).
 * Identity is the served URL; each event is a one-shot artifact row.
 */

import type {
	ChatConversationViewNode,
	ConversationMatchResult,
	ConversationNodeDefinition,
	PrimeSessionEvent,
} from "../dsh-client.js";
import { chatViewNode } from "../dsh-client.js";
import { recordOf, stringField } from "../lib/narrow.js";

export interface PrimeTearsheetRecord {
	readonly url: string;
	readonly name: string;
	readonly ts: string | undefined;
}

/** Tearsheets must stay on the host-served allowlisted prefix. */
export function isReportUrl(url: string): boolean {
	return url.startsWith("/prime-reports/");
}

export function matchTearsheet(event: PrimeSessionEvent): ConversationMatchResult | null {
	if (event.type !== "prime/tearsheet") return null;
	const data = recordOf(event.data);
	const url = stringField(data, "url");
	if (url === undefined || !isReportUrl(url)) return null;
	return { id: url, role: "start" };
}

export function foldTearsheet(
	previous: PrimeTearsheetRecord | undefined,
	event: PrimeSessionEvent,
): PrimeTearsheetRecord | undefined {
	if (event.type !== "prime/tearsheet") return previous;
	const data = recordOf(event.data);
	const url = stringField(data, "url");
	if (url === undefined || !isReportUrl(url) || (previous !== undefined && previous.url !== url)) return previous;
	return {
		url,
		name: stringField(data, "name") ?? previous?.name ?? url,
		ts: stringField(data, "ts") ?? previous?.ts,
	};
}

export const tearsheetDefinition: ConversationNodeDefinition<PrimeTearsheetRecord | undefined> = {
	kind: "prime-tearsheet",
	target: "chat",
	match: matchTearsheet,
	start: (_context, match) => foldTearsheet(undefined, match.event),
	update: (context, match) => foldTearsheet(context.state, match.event),
	buildViewNode: (context): ChatConversationViewNode | null => {
		const state = context.state;
		return state === undefined ? null : chatViewNode(context, "prime-tearsheet", state);
	},
};

/** Narrow a view-node payload back to its record (engine guarantees origin). */
export function isPrimeTearsheetData(data: unknown): data is PrimeTearsheetRecord {
	const record = recordOf(data);
	const url = record?.url;
	return typeof url === "string" && isReportUrl(url);
}
