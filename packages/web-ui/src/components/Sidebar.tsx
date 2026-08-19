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

const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<{ id: ViewId; label: string; badge?: string }> }> = [
	{
		label: "Workspace",
		items: [
			{ id: "dashboard", label: "Dashboard" },
			{ id: "rooms", label: "Rooms" },
			{ id: "bots", label: "Trading Bots" },
			{ id: "training", label: "Training Room" },
		],
	},
	{
		label: "Monitor",
		items: [
			{ id: "agents", label: "Agents" },
			{ id: "tasks", label: "Tasks" },
			{ id: "knowledge", label: "Knowledge Base", badge: "M2" },
		],
	},
	{
		label: "System",
		items: [
			{ id: "logs", label: "Logs", badge: "M2" },
			{ id: "settings", label: "Settings", badge: "M2" },
		],
	},
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
		<aside className="flex w-[216px] shrink-0 flex-col border-r border-term-border bg-term-panel">
			{/* Brand */}
			<div className="flex items-center gap-2.5 border-b border-term-border px-3.5 py-3.5">
				<span
					className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-term-bg"
					style={{ background: "linear-gradient(135deg, #4be3a8, #1f9d6b)" }}
				>
					PQ
				</span>
				<div className="leading-tight">
					<div className="text-[13px] font-semibold tracking-tight text-term-fg">Prime Quant</div>
					<div className="text-[10px] font-medium text-term-dim">agent os · v0.7.2</div>
				</div>
			</div>

			{/* Navigation */}
			<nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Views">
				{NAV_GROUPS.map((group) => (
					<div key={group.label} className="mb-3">
						<div className="px-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-term-dim">
							{group.label}
						</div>
						{group.items.map((item) => {
							const active = view === item.id;
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => navigate(item.id)}
									aria-current={active ? "page" : undefined}
									className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
										active
											? "bg-term-accent-soft font-medium text-term-accent"
											: "text-term-dim hover:bg-term-raised hover:text-term-fg"
									}`}
								>
									<ViewIcon view={item.id} className="shrink-0" />
									<span className="flex-1 truncate">{item.label}</span>
									{item.badge ? (
										<span className="rounded-md bg-term-overlay px-1.5 py-0.5 text-[9px] font-medium uppercase text-term-dim">
											{item.badge}
										</span>
									) : null}
								</button>
							);
						})}
					</div>
				))}
			</nav>

			{/* Live agents */}
			<div className="border-t border-term-border px-3.5 py-2.5">
				<div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-term-dim">live agents</div>
				{liveAgents.length === 0 ? (
					<div className="mt-1.5 text-[11px] text-term-dim">none running</div>
				) : (
					<ul className="mt-1.5 space-y-1.5">
						{liveAgents.map((agent) => (
							<li key={agent.id} className="flex items-center gap-1.5 text-[11px] text-term-fg">
								<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[agent.status]}`} />
								<span className="truncate">{agent.name}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Backend footer */}
			<div className="border-t border-term-border px-3.5 py-2.5 text-[10px] font-medium text-term-dim">
				{demo ? "demo backend" : (backend ?? "bridge")}
			</div>
		</aside>
	);
}
