/**
 * Live sub-agent monitor: rows of name, tier badge, status dot, tokens/min.
 * Running agents sort to the top so the active work is visible.
 */
import { useMemo } from "react";
import type { SubagentEvent, SubagentStatus } from "../lib/ws";

interface SubagentListProps {
	readonly subagents: Record<string, SubagentEvent>;
}

const STATUS_DOT: Record<SubagentStatus, string> = {
	RUNNING: "animate-pulse bg-term-yellow",
	DONE: "bg-term-green",
	ERROR: "bg-term-red",
};

const STATUS_BADGE: Record<SubagentStatus, string> = {
	RUNNING: "border-term-yellow text-term-yellow",
	DONE: "border-term-green text-term-green",
	ERROR: "border-term-red text-term-red",
};

function formatTpm(tokensPerMin?: number): string {
	if (tokensPerMin === undefined) return "";
	return `${(tokensPerMin / 1000).toFixed(1)}k tpm`;
}

export function SubagentList({ subagents }: SubagentListProps) {
	const agents = useMemo(() => {
		const rank: Record<SubagentStatus, number> = { RUNNING: 0, DONE: 1, ERROR: 2 };
		return Object.values(subagents).sort(
			(a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
		);
	}, [subagents]);

	if (agents.length === 0) {
		return <p className="px-3 py-2 text-[11px] text-term-dim">no workers active</p>;
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			{agents.map((agent) => (
				<div key={agent.id} className="flex items-center gap-2 border-b border-term-border px-3 py-2">
					<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[agent.status]}`} />
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs text-term-fg">{agent.name}</div>
						{agent.task ? (
							<div className="truncate text-[10px] text-term-dim" title={agent.task}>
								{agent.task}
							</div>
						) : null}
					</div>
					{formatTpm(agent.tokensPerMin) ? (
						<span className="shrink-0 text-[10px] text-term-dim">{formatTpm(agent.tokensPerMin)}</span>
					) : null}
					<span className={`shrink-0 border px-1.5 py-0.5 text-[10px] ${STATUS_BADGE[agent.status]}`}>
						{agent.status}
					</span>
				</div>
			))}
		</div>
	);
}
