/** prime/step renderer: inline chip with status icon, color, and detail tooltip. */

import type { PrimeStepRecord } from "../nodes/step.js";
import { stepLabel } from "../lib/title-case.js";

const COLOR_BORDER = "#30363d";
const COLOR_FG = "#e6edf3";
const COLOR_PASS = "#3fb950";
const COLOR_FAIL = "#f85149";
const COLOR_RUNNING = "#d29922";

const ICON: Readonly<Record<PrimeStepRecord["status"], string>> = {
	running: "◐",
	done: "✓",
	error: "✗",
};

const COLOR: Readonly<Record<PrimeStepRecord["status"], string>> = {
	running: COLOR_RUNNING,
	done: COLOR_PASS,
	error: COLOR_FAIL,
};

export interface StepViewProps {
	readonly step: PrimeStepRecord;
}

export function StepView({ step }: StepViewProps) {
	const color = COLOR[step.status];
	return (
		<span
			title={step.detail ?? step.status}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
				border: `1px solid ${COLOR_BORDER}`,
				background: "#0d1117",
				padding: "1px 6px",
				fontSize: 10,
				color,
			}}
		>
			<span aria-hidden="true">{ICON[step.status]}</span>
			<span style={{ color: COLOR_FG }}>{stepLabel(step.name)}</span>
		</span>
	);
}
