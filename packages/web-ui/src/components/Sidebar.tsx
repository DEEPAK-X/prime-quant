/**
 * OS shell nav rail: brand block, view navigation, live agents, backend footer.
 * Replaces the old sessions sidebar; session stats moved to the Dashboard view.
 */
import { useMemo } from "react";
import { navigate, type ViewId } from "../lib/navigation";
import type { SubagentEvent } from "../lib/ws";
import { ViewIcon } from "./icons";

interface SidebarProps {
	readonly view: ViewId;
	readonly backend: string | null;
	readonly demo: boolean;
	readonly subagents: Record<string, SubagentEvent>;
}

const NAV_ITEMS: ReadonlyArray<{ id: ViewId; label: string; badge?: string }> = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "agents", label: "Agents" },
	{ id: "rooms", label: "Rooms" },
	{ id: "bots", label: "Trading Bots" },
	{ id: "training", label: "Training Room" },
	{ id: "knowledge", label: "Knowledge Base", badge: "M2" },
	{ id: "tasks", label: "Tasks", badge: "M2" },
	{ id: "logs", label: "Logs", badge: "M2" },
	{ id: "settings", label: "Settings", badge: "M2" },
];

const AGENT_DOT: Record<SubagentEvent["status"], string> = {
	RUNNING: "bg-term-accent pq-dot-live",
	DONE: "bg-term-green",
	ERROR: "bg-term-red",
};

export function Sidebar({ view, backend, demo, subagents }: SidebarProps) {
	const liveAgents = useMemo(
		() =>
			Object.values(subagents)
				.filter((agent) => agent.status === "RUNNING")
				.slice(0, 5),
		[subagents],
	);

	return (
		<aside className="flex w-[208px] shrink-0 flex-col border-r border-term-border bg-term-panel">
			{/* Brand */}
			<div className="flex items-center gap-2.5 border-b border-term-border px-3 py-3">
				<span className="flex h-8 w-8 items-center justify-center border border-term-accent text-sm font-bold text-term-accent">
					PQ
				</span>
				<div className="leading-tight">
					<div className="text-xs font-bold tracking-widest text-term-fg">PRIME QUANT</div>
					<div className="text-[9px] uppercase tracking-widest text-term-dim">agent os</div>
				</div>
			</div>

			{/* Navigation */}
			<nav className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Views">
				{NAV_ITEMS.map((item) => {
					const active = view === item.id;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => navigate(item.id)}
							aria-current={active ? "page" : undefined}
							className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left text-xs transition-colors ${
								active
									? "border-term-accent bg-term-raised text-term-accent"
									: "border-transparent text-term-dim hover:bg-term-raised hover:text-term-fg"
							}`}
						>
							<ViewIcon view={item.id} className="shrink-0" />
							<span className="flex-1 truncate">{item.label}</span>
							{item.badge ? (
								<span className="border border-term-border px-1 text-[9px] uppercase text-term-dim">
									{item.badge}
								</span>
							) : null}
						</button>
					);
				})}
			</nav>

			{/* Live agents */}
			<div className="border-t border-term-border px-3 py-2">
				<div className="text-[9px] uppercase tracking-widest text-term-dim">live agents</div>
				{liveAgents.length === 0 ? (
					<div className="mt-1 text-[10px] text-term-dim">none running</div>
				) : (
					<ul className="mt-1 space-y-1">
						{liveAgents.map((agent) => (
							<li key={agent.id} className="flex items-center gap-1.5 text-[10px] text-term-fg">
								<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[agent.status]}`} />
								<span className="truncate">{agent.name}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Backend footer */}
			<div className="border-t border-term-border px-3 py-2 text-[9px] uppercase tracking-widest text-term-dim">
				{demo ? "demo backend" : (backend ?? "bridge")} · v0.7.2
			</div>
		</aside>
	);
}
