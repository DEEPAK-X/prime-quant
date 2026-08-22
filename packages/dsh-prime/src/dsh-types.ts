/**
 * Manual DSH host seams used by this plugin.
 * pinned dsh@unverified-no-workspace-dep — DSH is not a workspace package
 * (docs/dsh-adapter/03 A0). Duck-typed so apply() works without importing Cordis.
 */

import type { AgentState, V2Event } from "@earendil-works/pi-web-ui-server";
import type { PrimeSessionAppend } from "./prime-events.js";

export type Transport = "rpc";

export interface PrimeTransport {
	ensure(): Promise<void>;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	subscribe(listener: (event: V2Event) => void): () => void;
	getLastAssistantText(): Promise<string | undefined>;
	getAgentState(): AgentState;
	isBusy(): boolean;
}

export interface PrimeSubagentRequest {
	text?: string;
	blocks?: Array<{ type?: string; text?: string }>;
	cwd?: string;
}

export interface PrimeSubagentResult {
	output: string;
	stopReason: "completed" | "aborted" | "error";
}

export interface PrimeSubagentRun {
	result: Promise<PrimeSubagentResult>;
	dispose(): Promise<void>;
}

export interface PrimeSubagentProvider {
	readonly inheritsParentContext: false;
	readonly capabilities: readonly string[];
	start(request: PrimeSubagentRequest): Promise<PrimeSubagentRun>;
}

export interface PrimeHttpRequest {
	url?: string;
	method?: string;
}

export interface PrimeHttpResponse {
	status(code: number): PrimeHttpResponse;
	json(body: unknown): void;
	type(contentType: string): PrimeHttpResponse;
	send(body: string | Buffer): void;
	end(): void;
}

export type PrimeStatusPool = "idle" | "busy" | "stopped";

export interface PrimeStatusBody {
	mt5: {
		status: "ok" | "down" | "unknown";
		detail: { server?: string; login?: number; symbols?: number } | null;
		checkedAt: string | null;
	};
	cliPath: string | null;
	pool: PrimeStatusPool;
}

export interface PrimeWebServer {
	get(path: string, handler: (req: PrimeHttpRequest, res: PrimeHttpResponse) => void | Promise<void>): void;
}

export interface PrimeSessionLog {
	append(event: PrimeSessionAppend): void;
}

export interface HostContext {
	subagents?: {
		register(name: string, provider: PrimeSubagentProvider): void;
	};
	webServer?: PrimeWebServer;
	systemPrompt?: {
		register(section: { id: string; content: string }): void;
	};
	sessions?: PrimeSessionLog;
	effect?: (setup: () => () => void) => void;
}

export function concatenateRequestText(request: PrimeSubagentRequest): string {
	const parts: string[] = [];
	if (typeof request.text === "string" && request.text.trim()) {
		parts.push(request.text);
	}
	if (request.blocks) {
		for (const block of request.blocks) {
			if (typeof block.text === "string" && block.text.trim()) {
				parts.push(block.text);
			}
		}
	}
	return parts.join("\n").trim();
}
