/**
 * Vertical pipeline timeline: step history grouped by run id, newest run first.
 *
 * A "run id" is the prefix of a step id before the first `-` (the contract
 * emits ids like `<runId>-<stepName>`). Within a run, steps are ordered by
 * their position in the canonical pipeline order (ast_check → fetch_data →
 * backtest → optimize → cpcv_gate → tearsheet), with unknown steps appended in
 * id order. Each row shows the step label, status dot/color, and detail.
 */
import { useMemo } from "react";
import type { KnownStepName, StepEvent, StepStatus } from "../lib/ws";

interface PipelineViewProps {
	readonly steps: Record<string, StepEvent>;
}

const PIPELINE_ORDER: Array<{ name: KnownStepName; label: string }> = [
	{ name: "ast_check", label: "AST check" },
	{ name: "fetch_data", label: "Fetch data" },
	{ name: "backtest", label: "Backtest" },
	{ name: "optimize", label: "Optimize" },
	{ name: "cpcv_gate", label: "CPCV gate" },
	{ name: "tearsheet", label: "Tearsheet" },
];

const DOT: Record<StepStatus, string> = {
	running: "animate-pulse bg-term-yellow",
	done: "bg-term-green",
	error: "bg-term-red",
};

const COLOR: Record<StepStatus, string> = {
	running: "text-term-yellow",
	done: "text-term-green",
	error: "text-term-red",
};

function runIdOf(step: StepEvent): string {
	const dash = step.id.indexOf("-");
	return dash === -1 ? step.id : step.id.slice(0, dash);
}

function orderIndex(name: string): number {
	const idx = PIPELINE_ORDER.findIndex((step) => step.name === name);
	return idx === -1 ? PIPELINE_ORDER.length : idx;
}

function labelFor(name: string): string {
	const found = PIPELINE_ORDER.find((step) => step.name === name);
	return found ? found.label : name.replace(/_/g, " ");
}

export function PipelineView({ steps }: PipelineViewProps) {
	const runs = useMemo(() => {
		const grouped = new Map<string, StepEvent[]>();
		for (const step of Object.values(steps)) {
			const runId = runIdOf(step);
			const list = grouped.get(runId);
			if (list) list.push(step);
			else grouped.set(runId, [step]);
		}
		for (const list of grouped.values()) {
			list.sort(
				(a, b) => orderIndex(a.name) - orderIndex(b.name) || a.id.localeCompare(b.id),
			);
		}
		// Newest run first by id string (runIds embed timestamps).
		return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));
	}, [steps]);

	if (runs.length === 0) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="px-6 text-center text-[11px] leading-relaxed text-term-dim">
					no pipeline steps yet — run history appears here
				</p>
			</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
			<div className="space-y-4">
				{runs.map(([runId, list]) => (
					<div key={runId}>
						<div className="mb-1.5 text-[10px] uppercase tracking-wider text-term-dim">run · {runId}</div>
						<ol className="space-y-1 border-l border-term-border pl-3">
							{list.map((step) => (
								<li key={step.id} className="flex items-start gap-2">
									<span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[step.status]}`} />
									<div className="min-w-0 flex-1">
										<div className="flex items-baseline justify-between gap-2">
											<span className={`text-xs ${COLOR[step.status]}`}>{labelFor(step.name)}</span>
											<span className="shrink-0 text-[9px] uppercase tracking-wider text-term-dim">
												{step.status}
											</span>
										</div>
										{step.detail ? (
											<p className="truncate text-[10px] text-term-dim" title={step.detail}>
												{step.detail}
											</p>
										) : null}
									</div>
								</li>
							))}
						</ol>
					</div>
				))}
			</div>
		</div>
	);
}
