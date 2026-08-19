/**
 * Trading Bots view (A5): pipeline run history with per-run step detail,
 * the latest validation-gate verdict, and the tearsheet library. Runs are
 * derived client-side from step-id groups (lib/runs.ts) — no new server
 * events.
 */
import { useMemo, useState } from "react";
import { FilesView } from "../components/FilesView";
import { QuantCard } from "../components/QuantCard";
import { TearsheetView } from "../components/TearsheetView";
import { VirtualRows } from "../components/VirtualRows";
import { Badge, PageHeader, SectionHeader, type Tone } from "../components/ui";
import { deriveRuns, formatRunTime, type PipelineRun } from "../lib/runs";
import { useQuantStore } from "../lib/store";
import type { StepEvent } from "../lib/ws";

const RUN_TONE: Record<PipelineRun["status"], Tone> = { running: "accent", done: "green", error: "red" };
const STEP_TONE: Record<StepEvent["status"], Tone> = { running: "accent", done: "green", error: "red" };
const RUN_ROW_HEIGHT = 56;

function RunDetail({ run }: { readonly run: PipelineRun }) {
	const { cards } = useQuantStore();
	const latestCard = Object.values(cards).at(-1);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
			<div className="pq-frame pq-view-in rounded-[10px] p-4">
				<div className="flex items-center justify-between">
					<span className="text-xs font-semibold text-term-fg">{run.id}</span>
					<Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
				</div>
				<ol className="mt-3 space-y-2">
					{run.steps.map((step) => (
						<li key={step.id} className="flex items-center gap-3 text-[11px]">
							<Badge tone={STEP_TONE[step.status]}>{step.status}</Badge>
							<span className="font-medium text-term-fg">{step.name}</span>
							{step.detail ? <span className="truncate text-term-dim">{step.detail}</span> : null}
						</li>
					))}
				</ol>
			</div>
			{latestCard?.payload.validation_gate !== undefined ? (
				<div className="pq-frame pq-view-in mt-3 rounded-[10px] p-4">
					<SectionHeader title="validation gate" />
					<div className="pt-2">
						<QuantCard card={latestCard} />
					</div>
				</div>
			) : null}
		</div>
	);
}

export function BotsView() {
	const { steps, tearsheetUrl, tearsheets, artifacts } = useQuantStore();
	const runs = useMemo(() => deriveRuns(steps), [steps]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title="Trading Bots"
				description="pipeline runs, validation-gate verdicts, and reports"
				actions={
					<Badge tone="dim">
						{tearsheets.length} report{tearsheets.length === 1 ? "" : "s"}
					</Badge>
				}
			/>
			<div className="flex min-h-0 flex-1">
				{/* Run history */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-term-border">
					<SectionHeader title="run history" count={runs.length} />
					<VirtualRows
						items={runs}
						rowHeight={RUN_ROW_HEIGHT}
						className="min-h-0 flex-1"
						empty={
							<p className="px-4 py-6 text-[11px] text-term-dim">
								no runs yet — start one from Rooms, e.g. “backtest EURUSD M5 sma cross”.
							</p>
						}
						renderRow={(run) => (
							<button
								key={run.id}
								type="button"
								onClick={() => setSelectedId(run.id)}
								aria-current={selected?.id === run.id ? "page" : undefined}
								className={`flex w-full flex-col gap-1 border-b border-term-border px-3.5 py-2 text-left transition-colors duration-150 ${
									selected?.id === run.id ? "bg-term-accent-soft" : "hover:bg-term-raised"
								}`}
								style={{ height: RUN_ROW_HEIGHT }}
							>
								<span className="flex items-center justify-between gap-2">
									<span className="truncate text-[11px] font-medium text-term-fg">{run.id}</span>
									<Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
								</span>
								<span className="text-[10px] text-term-dim">
									{formatRunTime(run.startedAt)} · {run.steps.length} step{run.steps.length === 1 ? "" : "s"}
								</span>
							</button>
						)}
					/>
				</aside>

				{/* Run detail + tearsheet */}
				<section className="flex min-w-0 flex-1 flex-col">
					{selected ? (
						<RunDetail run={selected} />
					) : (
						<div className="flex min-h-0 flex-1 flex-col">
							<TearsheetView url={tearsheetUrl} />
						</div>
					)}
				</section>

				{/* Library */}
				<aside className="flex w-[300px] min-w-[240px] shrink-0 flex-col border-l border-term-border">
					<SectionHeader title="artifacts" />
					<FilesView artifacts={artifacts} />
					{tearsheets.length > 0 ? (
						<>
							<SectionHeader title="tearsheet library" count={tearsheets.length} />
							<div className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
								{tearsheets.map((sheet) => (
									<a
										key={sheet.url}
										href={sheet.url}
										target="_blank"
										rel="noreferrer"
										className="block truncate rounded-lg px-2 py-1.5 text-[10px] text-term-fg transition-colors duration-150 hover:bg-term-raised"
										title={sheet.ts ?? sheet.url}
									>
										{sheet.name ?? sheet.url}
									</a>
								))}
							</div>
						</>
					) : null}
				</aside>
			</div>
		</div>
	);
}
