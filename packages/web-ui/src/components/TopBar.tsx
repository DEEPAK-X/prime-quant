import type { AgentState, ConnectionState, Mt5State, Protocol } from "../lib/ws";

const STATE_PILL: Record<AgentState, { label: string; cls: string }> = {
	starting: { label: "starting", cls: "border-term-yellow text-term-yellow" },
	ready: { label: "ready", cls: "border-term-green text-term-green" },
	busy: { label: "busy", cls: "border-term-accent text-term-accent" },
	error: { label: "error", cls: "border-term-red text-term-red" },
	stopped: { label: "stopped", cls: "border-term-dim text-term-dim" },
};

const MT5_PILL: Record<Mt5State["status"], { label: string; cls: string }> = {
	ok: { label: "ok", cls: "border-term-green text-term-green" },
	down: { label: "down", cls: "border-term-red text-term-red" },
	unknown: { label: "unknown", cls: "border-term-dim text-term-dim" },
};

const CONN_COLOR: Record<ConnectionState, string> = {
	open: "text-term-green",
	connecting: "text-term-yellow",
	closed: "text-term-red",
};

interface TopBarProps {
	readonly protocol: Protocol | null;
	readonly demo: boolean;
	readonly agentState: AgentState | null;
	readonly mt5: Mt5State;
	readonly connection: ConnectionState;
	readonly artifactPaneOpen: boolean;
	readonly onToggleArtifactPane: () => void;
}

export function TopBar({
	protocol,
	demo,
	agentState,
	mt5,
	connection,
	artifactPaneOpen,
	onToggleArtifactPane,
}: TopBarProps) {
	const state = agentState ? STATE_PILL[agentState] : null;
	const mt5Pill = MT5_PILL[mt5.status];
	const mt5Server = mt5.detail?.server;

	return (
		<header className="flex shrink-0 items-center gap-3 border-b border-term-border px-3 py-1.5">
			<span className="text-xs font-bold tracking-widest text-term-fg">
				primequant <span className="font-normal text-term-dim">//</span>{" "}
				<span className="font-normal text-term-accent">quant-research</span>
			</span>

			<div className="flex items-center gap-2">
				{state ? (
					<span
						className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${state.cls}`}
						title={agentState ?? undefined}
					>
						{state.label}
					</span>
				) : null}
				{protocol === 2 ? (
					<span className="border border-term-dim px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-term-dim">
						v2
					</span>
				) : null}
				{demo ? (
					<span className="border border-term-yellow px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-term-yellow">
						demo
					</span>
				) : null}
				<span
					className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${mt5Pill.cls}`}
					title={mt5Server ?? "MT5 status"}
				>
					mt5 {mt5Pill.label}
					{mt5Server ? <span className="ml-1 text-term-dim">· {mt5Server}</span> : null}
				</span>
			</div>

			<div className="ml-auto flex items-center gap-3">
				<span className="text-[10px] uppercase tracking-wider text-term-dim">
					ws <span className={CONN_COLOR[connection]}>{connection}</span>
				</span>
				<button
					type="button"
					onClick={onToggleArtifactPane}
					aria-pressed={artifactPaneOpen}
					aria-label={artifactPaneOpen ? "Hide artifact panel" : "Show artifact panel"}
					className={`border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
						artifactPaneOpen
							? "border-term-accent text-term-accent"
							: "border-term-border text-term-dim hover:text-term-fg"
					}`}
				>
					artifacts
				</button>
			</div>
		</header>
	);
}
