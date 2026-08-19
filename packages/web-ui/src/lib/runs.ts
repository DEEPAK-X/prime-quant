/**
 * Pipeline run derivation (A5). A "run" is a group of step events sharing an
 * id prefix (everything before the last dash, e.g. `run-1234-backtest`).
 * Pure derivation over the store's step records — no server changes.
 */
import type { StepEvent } from "./contract";

export interface PipelineRun {
	readonly id: string;
	readonly steps: StepEvent[];
	readonly status: "running" | "done" | "error";
	readonly startedAt: number | null;
}

function runStatus(steps: readonly StepEvent[]): PipelineRun["status"] {
	if (steps.some((step) => step.status === "error")) return "error";
	if (steps.some((step) => step.status === "running")) return "running";
	return "done";
}

/** Extract a timestamp from run ids of the form `run-<epoch>-<n>`. */
function runTimestamp(id: string): number | null {
	const match = /^run-(\d+)/.exec(id);
	return match ? Number(match[1]) : null;
}

export function deriveRuns(steps: Record<string, StepEvent>): PipelineRun[] {
	const groups = new Map<string, StepEvent[]>();
	for (const step of Object.values(steps)) {
		const dash = step.id.lastIndexOf("-");
		const runId = dash === -1 ? step.id : step.id.slice(0, dash);
		const list = groups.get(runId) ?? [];
		list.push(step);
		groups.set(runId, list);
	}
	return [...groups.entries()]
		.map(([id, list]) => ({
			id,
			steps: list.sort((a, b) => a.id.localeCompare(b.id)),
			status: runStatus(list),
			startedAt: runTimestamp(id),
		}))
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function formatRunTime(ts: number | null): string {
	if (ts === null) return "—";
	return new Date(ts).toLocaleTimeString();
}
