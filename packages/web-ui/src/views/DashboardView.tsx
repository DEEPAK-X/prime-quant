/**
 * Dashboard: the command-center landing grid. Run stats (from pipeline step
 * groups), system strip, latest tearsheet, quant cards, recent errors — all
 * derived from the single store, no new data sources.
 */
import { useMemo } from "react";
import { QuantCard } from "../components/QuantCard";
import { navigate } from "../lib/navigation";
import { useQuantStore } from "../lib/store";

interface RunStats {
	readonly runs: number;
	readonly lastVerdict: "PASS" | "FAIL" | "—";
}

const VERDICT_COLOR: Record<RunStats["lastVerdict"], string> = {
	PASS: "text-term-accent",
	FAIL: "text-term-red",
	"—": "text-term-dim",
};

function StatTile({ label, value, tone, onClick }: { readonly label: string; readonly value: string; readonly tone?: string; readonly onClick?: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="pq-frame flex flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-term-raised"
		>
			<span className="text-[9px] uppercase tracking-widest text-term-dim">{label}</span>
			<span className={`text-2xl font-bold ${tone ?? "text-term-fg"}`}>{value}</span>
		</button>
	);
}

export function DashboardView() {
	const { agentState, mt5, connection, messages, steps, subagents, cards, tearsheets, errors } = useQuantStore();

	const stats = useMemo<RunStats>(() => {
		const runIds = new Set<string>();
		for (const id of Object.keys(steps)) {
			const dash = id.lastIndexOf("-");
			runIds.add(dash === -1 ? id : id.slice(0, dash));
		}
		let lastVerdict: RunStats["lastVerdict"] = "—";
		if (tearsheets.length > 0) lastVerdict = "PASS";
		for (const event of Object.values(steps)) {
			if (event.status === "error") lastVerdict = "FAIL";
		}
		if (messages.length === 0 && runIds.size === 0) lastVerdict = "—";
		return { runs: runIds.size, lastVerdict };
	}, [messages, steps, tearsheets]);

	const runningAgents = Object.values(subagents).filter((agent) => agent.status === "RUNNING").length;
	const latestSheet = tearsheets[0];
	const cardList = Object.values(cards).slice(-2);
	const recentErrors = errors.slice(-3).reverse();

	return (
		<div className="pq-grid-bg min-h-0 flex-1 overflow-y-auto p-4">
			<div className="pq-view-in mx-auto max-w-5xl space-y-4">
				<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
					<StatTile label="orchestrator" value={agentState ?? "—"} onClick={() => navigate("rooms")} />
					<StatTile
						label="mt5 feed"
						value={mt5.status}
						tone={mt5.status === "ok" ? "text-term-accent" : mt5.status === "down" ? "text-term-red" : "text-term-dim"}
					/>
					<StatTile label="live agents" value={`${runningAgents}`} onClick={() => navigate("agents")} />
					<StatTile
						label="pipeline runs"
						value={`${stats.runs}`}
						tone={VERDICT_COLOR[stats.lastVerdict]}
						onClick={() => navigate("bots")}
					/>
				</div>

				<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
					<section className="pq-frame flex min-h-[180px] flex-col p-4">
						<span className="text-[9px] uppercase tracking-widest text-term-dim">latest tearsheet</span>
						{latestSheet ? (
							<a
								href={latestSheet.url}
								target="_blank"
								rel="noreferrer"
								className="mt-2 text-sm text-term-accent underline"
							>
								{latestSheet.name ?? latestSheet.url}
							</a>
						) : (
							<p className="mt-2 text-[11px] text-term-dim">
								no tearsheets yet — run a pipeline from Rooms, e.g. “backtest EURUSD M5 sma cross”.
							</p>
						)}
						<div className="mt-auto pt-3 text-[10px] text-term-dim">
							verdict <span className={VERDICT_COLOR[stats.lastVerdict]}>{stats.lastVerdict}</span> ·{" "}
							{tearsheets.length} report{tearsheets.length === 1 ? "" : "s"} · connection {connection}
						</div>
					</section>

					<section className="pq-frame flex min-h-[180px] flex-col p-4">
						<span className="text-[9px] uppercase tracking-widest text-term-dim">recent quant cards</span>
						{cardList.length === 0 ? (
							<p className="mt-2 text-[11px] text-term-dim">cards appear here after backtests and validations.</p>
						) : (
							<div className="mt-2 space-y-2 overflow-y-auto">
								{cardList.map((card) => (
									<QuantCard key={card.id} card={card} />
								))}
							</div>
						)}
					</section>
				</div>

				{recentErrors.length > 0 ? (
					<section className="pq-frame p-4">
						<span className="text-[9px] uppercase tracking-widest text-term-dim">recent errors</span>
						<ul className="mt-2 space-y-1">
							{recentErrors.map((error, index) => (
								<li key={`${error.ts}-${index}`} className="text-[11px] text-term-red">
									[{error.scope}] {error.message}
								</li>
							))}
						</ul>
					</section>
				) : null}
			</div>
		</div>
	);
}
