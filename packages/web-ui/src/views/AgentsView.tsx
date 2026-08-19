/**
 * Agents view: full sub-agent roster in a virtualized table (fixed-height
 * rows, viewport windowing via VirtualRows) so the pane stays cheap even
 * with a long watcher history.
 */
import { useMemo } from "react";
import { VirtualRows } from "../components/VirtualRows";
import { useQuantStore } from "../lib/store";
import type { SubagentStatus } from "../lib/ws";

const STATUS_TONE: Record<SubagentStatus, string> = {
	RUNNING: "text-term-accent",
	DONE: "text-term-green",
	ERROR: "text-term-red",
};

const AGENT_ROW_HEIGHT = 44;

export function AgentsView() {
	const { subagents } = useQuantStore();

	const agents = useMemo(() => {
		const rank: Record<SubagentStatus, number> = { RUNNING: 0, DONE: 1, ERROR: 2 };
		return Object.values(subagents).sort(
			(a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
		);
	}, [subagents]);

	return (
		<div className="pq-grid-bg flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center justify-between border-b border-term-border px-4 py-2">
				<span className="text-xs uppercase tracking-widest text-term-dim">agents // roster</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">{agents.length} total</span>
			</header>
			<div className="flex shrink-0 items-center gap-4 border-b border-term-border px-4 py-1.5 text-[9px] uppercase tracking-widest text-term-dim">
				<span className="w-20">status</span>
				<span className="flex-1">agent</span>
				<span className="w-20">tier</span>
				<span className="w-20 text-right">tokens/min</span>
			</div>
			<VirtualRows
				items={agents}
				rowHeight={AGENT_ROW_HEIGHT}
				className="pq-view-in min-h-0 flex-1"
				empty={<p className="px-4 py-6 text-[11px] text-term-dim">no sub-agents spawned yet — watcher presets arrive in M2.</p>}
				renderRow={(agent) => (
					<div
						key={agent.id}
						className="flex items-center gap-4 border-b border-term-border px-4"
						style={{ height: AGENT_ROW_HEIGHT }}
					>
						<span className={`w-20 text-[10px] uppercase ${STATUS_TONE[agent.status]}`}>{agent.status}</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs text-term-fg">{agent.name}</span>
							{agent.task ? <span className="block truncate text-[10px] text-term-dim">{agent.task}</span> : null}
						</span>
						<span className="w-20 text-[10px] uppercase text-term-dim">{agent.tier}</span>
						<span className="w-20 text-right text-[10px] text-term-dim">
							{agent.tokensPerMin !== undefined ? `${(agent.tokensPerMin / 1000).toFixed(1)}k` : "—"}
						</span>
					</div>
				)}
			/>
		</div>
	);
}
