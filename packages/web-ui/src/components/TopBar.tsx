/**
 * OS shell status bar: mode badge, agent state, protocol, MT5 pill (click to
 * re-probe), WS state, live clock, command-rail toggle. One thin scan strip —
 * everything on it comes from the store, nothing is fabricated.
 */
import { useEffect, useState } from "react";
import type { AgentState, ConnectionState, Mt5State, Protocol } from "../lib/ws";

const STATE_PILL: Record<AgentState, { label: string; cls: string }> = {
	starting: { label: "starting", cls: "border-term-yellow text-term-yellow" },
	ready: { label: "ready", cls: "border-term-accent text-term-accent" },
	busy: { label: "busy", cls: "border-term-accent text-term-accent" },
	error: { label: "error", cls: "border-term-red text-term-red" },
	stopped: { label: "stopped", cls: "border-term-dim text-term-dim" },
};

const MT5_PILL: Record<Mt5State["status"], { label: string; cls: string }> = {
	ok: { label: "ok", cls: "border-term-accent text-term-accent" },
	down: { label: "down", cls: "border-term-red text-term-red" },
	unknown: { label: "unknown", cls: "border-term-dim text-term-dim" },
};

const CONN_COLOR: Record<ConnectionState, string> = {
	open: "text-term-accent",
	connecting: "text-term-yellow",
	closed: "text-term-red",
};

function useClock(): string {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	return now.toLocaleTimeString([], { hour12: false });
}

interface TopBarProps {
	readonly protocol: Protocol | null;
	readonly demo: boolean;
	readonly agentState: AgentState | null;
	readonly mt5: Mt5State;
	readonly connection: ConnectionState;
	readonly railOpen: boolean;
	readonly onToggleRail: () => void;
	readonly onRefreshMt5: () => void;
}

export function TopBar({
	protocol,
	demo,
	agentState,
	mt5,
	connection,
	railOpen,
	onToggleRail,
	onRefreshMt5,
}: TopBarProps) {
	const state = agentState ? STATE_PILL[agentState] : null;
	const mt5Pill = MT5_PILL[mt5.status];
	const mt5Server = mt5.detail?.server;
	const clock = useClock();

	return (
		<header className="pq-statusbar flex shrink-0 items-center gap-3 border-b border-term-border px-3 py-1.5">
			<span
				className={`border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
					demo ? "border-term-yellow text-term-yellow" : "border-term-accent text-term-accent"
				}`}
			>
				{demo ? "demo mode" : "local mode"}
			</span>

			<div className="flex items-center gap-2">
				{state ? (
					<span
						className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${state.cls}`}
						title="orchestrator state"
					>
						{state.label}
					</span>
				) : null}
				{protocol === 2 ? (
					<span className="border border-term-dim px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-term-dim">
						v2
					</span>
				) : null}
				<button
					type="button"
					onClick={onRefreshMt5}
					className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-term-raised ${mt5Pill.cls}`}
					title={mt5Server ? `${mt5Server} — click to re-probe` : "MT5 status — click to re-probe"}
				>
					mt5 {mt5Pill.label}
					{mt5Server ? <span className="ml-1 text-term-dim">· {mt5Server}</span> : null}
				</button>
			</div>

			<div className="ml-auto flex items-center gap-3">
				<span className="text-[10px] uppercase tracking-wider text-term-dim">
					ws{" "}
					<span className={CONN_COLOR[connection]}>
						{connection === "open" ? <span className="pq-dot-live mr-1 inline-block h-1.5 w-1.5 rounded-full bg-term-accent align-middle" /> : null}
						{connection}
					</span>
				</span>
				<span className="text-[10px] tracking-wider text-term-dim" suppressHydrationWarning>
					{clock}
				</span>
				<button
					type="button"
					onClick={onToggleRail}
					aria-pressed={railOpen}
					aria-label={railOpen ? "Hide command rail" : "Show command rail"}
					className={`border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
						railOpen
							? "border-term-accent text-term-accent"
							: "border-term-border text-term-dim hover:text-term-fg"
					}`}
				>
					rail
				</button>
			</div>
		</header>
	);
}
