/**
 * Inline pipeline step chip: status icon + name + color, with the step detail
 * surfaced as a title tooltip. Open-ended step names from the contract are
 * accepted (KnownStepName is the known set, not a constraint).
 */
import type { KnownStepName, StepEvent, StepStatus } from "../lib/ws";

interface StepChipProps {
	readonly step: StepEvent;
}

const ICON: Record<StepStatus, string> = {
	running: "◐",
	done: "✓",
	error: "✗",
};

const COLOR: Record<StepStatus, string> = {
	running: "text-term-yellow",
	done: "text-term-green",
	error: "text-term-red",
};

// Friendly labels for the known pipeline steps; unknown names render as-is.
const LABEL: Readonly<Record<KnownStepName, string>> = {
	ast_check: "ast check",
	backtest: "backtest",
	cpcv_gate: "cpcv gate",
	optimize: "optimize",
	tearsheet: "tearsheet",
	fetch_data: "fetch data",
};

function labelFor(name: string): string {
	return (LABEL as Record<string, string>)[name] ?? name.replace(/_/g, " ");
}

export function StepChip({ step }: StepChipProps) {
	const icon = ICON[step.status];
	const color = COLOR[step.status];
	return (
		<span
			className={`inline-flex items-center gap-1 border border-term-border bg-term-bg px-1.5 py-0.5 text-[10px] ${color}`}
			title={step.detail ?? step.status}
		>
			<span className={color} aria-hidden="true">
				{icon}
			</span>
			<span className="text-term-fg">{labelFor(step.name)}</span>
		</span>
	);
}
