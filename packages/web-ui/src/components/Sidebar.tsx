import { useMemo } from "react";
import type { ChatMessage, StepEvent, TearsheetEntry } from "../lib/ws";

interface SidebarProps {
	readonly sessionId: string | null;
	readonly messages: ChatMessage[];
	readonly steps: Record<string, StepEvent>;
	readonly tearsheets: TearsheetEntry[];
}

interface Stats {
	readonly runs: number;
	readonly lastVerdict: "PASS" | "FAIL" | "—";
}

function deriveStats(messages: ChatMessage[], steps: Record<string, StepEvent>, tearsheets: TearsheetEntry[]): Stats {
	// A "run" is a step event group; group by the run prefix (id up to last dash-name).
	const runIds = new Set<string>();
	for (const id of Object.keys(steps)) {
		const dashIndex = id.lastIndexOf("-");
		runIds.add(dashIndex === -1 ? id : id.slice(0, dashIndex));
	}
	let lastVerdict: "PASS" | "FAIL" | "—" = "—";
	if (tearsheets.length > 0) lastVerdict = "PASS";
	for (const event of Object.values(steps)) {
		if (event.status === "error") lastVerdict = "FAIL";
	}
	if (messages.length === 0 && runIds.size === 0) lastVerdict = "—";
	return { runs: runIds.size, lastVerdict };
}

const VERDICT_COLOR: Record<"PASS" | "FAIL" | "—", string> = {
	PASS: "text-term-green",
	FAIL: "text-term-red",
	"—": "text-term-dim",
};

export function Sidebar({ sessionId, messages, steps, tearsheets }: SidebarProps) {
	const stats = useMemo(() => deriveStats(messages, steps, tearsheets), [messages, steps, tearsheets]);

	return (
		<aside className="flex w-[220px] shrink-0 flex-col border-r border-term-border bg-term-bg">
			<div className="border-b border-term-border px-3 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] uppercase tracking-wider text-term-dim">sessions</span>
					<button
						type="button"
						disabled
						title="multi-session in v2"
						aria-label="New session (disabled, multi-session in v2)"
						className="cursor-not-allowed border border-term-border px-1.5 text-[10px] text-term-dim"
					>
						+ new
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<button
					type="button"
					className="flex w-full flex-col gap-0.5 border-b border-term-border px-3 py-2 text-left hover:bg-term-panel"
				>
					<span className="truncate text-xs text-term-fg">{sessionId ?? "gui-session"}</span>
					<span className="text-[10px] uppercase tracking-wider text-term-dim">active</span>
				</button>
			</div>

			<div className="border-t border-term-border px-3 py-2">
				<span className="text-[10px] uppercase tracking-wider text-term-dim">stats</span>
				<dl className="mt-1.5 space-y-1">
					<div className="flex items-center justify-between">
						<dt className="text-[10px] uppercase tracking-wider text-term-dim">runs</dt>
						<dd className="text-xs text-term-fg">{stats.runs}</dd>
					</div>
					<div className="flex items-center justify-between">
						<dt className="text-[10px] uppercase tracking-wider text-term-dim">verdict</dt>
						<dd className={`text-xs ${VERDICT_COLOR[stats.lastVerdict]}`}>{stats.lastVerdict}</dd>
					</div>
					<div className="flex items-center justify-between">
						<dt className="text-[10px] uppercase tracking-wider text-term-dim">tearsheets</dt>
						<dd className="text-xs text-term-fg">{tearsheets.length}</dd>
					</div>
				</dl>
			</div>
		</aside>
	);
}
