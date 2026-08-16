import { Fragment } from "react";
import type { KnownStepName, StepEvent, StepStatus } from "../lib/ws";

const PIPELINE: Array<{ name: KnownStepName; label: string }> = [
	{ name: "ast_check", label: "AST CHECK" },
	{ name: "backtest", label: "BACKTEST" },
	{ name: "cpcv_gate", label: "CPCV GATE" },
];

const DOT: Record<StepStatus | "idle", string> = {
	idle: "bg-term-border",
	running: "animate-pulse bg-term-yellow",
	done: "bg-term-green",
	error: "bg-term-red",
};

const LABEL: Record<StepStatus | "idle", string> = {
	idle: "text-term-dim",
	running: "text-term-yellow",
	done: "text-term-green",
	error: "text-term-red",
};

export function PipelineStrip({ steps }: { steps: Record<string, StepEvent> }) {
	const latest = new Map<KnownStepName, StepStatus | "idle">(PIPELINE.map((step) => [step.name, "idle"]));
	for (const event of Object.values(steps)) {
		if (latest.has(event.name as KnownStepName)) {
			latest.set(event.name as KnownStepName, event.status);
		}
	}

	return (
		<div className="flex items-center gap-2 border-b border-term-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-term-dim">
			{PIPELINE.map((step, index) => {
				const state = latest.get(step.name) ?? "idle";
				return (
					<Fragment key={step.name}>
						{index > 0 ? <span className="text-term-border">→</span> : null}
						<span className="flex items-center gap-1.5">
							<span className={`h-1.5 w-1.5 ${DOT[state]}`} />
							<span className={LABEL[state]}>{step.label}</span>
						</span>
					</Fragment>
				);
			})}
		</div>
	);
}
