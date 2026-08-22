/** prime/subagent renderer: name, tier badge, status dot, task text. */

import type { PrimeSubagentRecord } from "../nodes/subagent.js";

const COLOR_BORDER = "#30363d";
const COLOR_FG = "#e6edf3";
const COLOR_DIM = "#8b949e";
const COLOR_BG = "#0d1117";
const COLOR_PASS = "#3fb950";
const COLOR_FAIL = "#f85149";
const COLOR_RUNNING = "#d29922";

const DOT: Readonly<Record<PrimeSubagentRecord["status"], string>> = {
	RUNNING: COLOR_RUNNING,
	DONE: COLOR_PASS,
	ERROR: COLOR_FAIL,
};

export interface SubagentViewProps {
	readonly subagent: PrimeSubagentRecord;
}

export function SubagentView({ subagent }: SubagentViewProps) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				border: `1px solid ${COLOR_BORDER}`,
				background: COLOR_BG,
				padding: "4px 8px",
				fontSize: 11,
				maxWidth: 480,
			}}
		>
			<span
				aria-label={`subagent ${subagent.status}`}
				style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: DOT[subagent.status] }}
			/>
			<span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLOR_FG }}>
				{subagent.name}
			</span>
			{subagent.tier !== undefined ? (
				<span style={{ border: `1px solid ${COLOR_BORDER}`, padding: "0 5px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_DIM }}>
					{subagent.tier}
				</span>
			) : null}
			{subagent.task !== undefined ? (
				<span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLOR_DIM }}>
					{subagent.task}
				</span>
			) : null}
			<span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10, color: DIM_FOR_STATUS[subagent.status] }}>{subagent.status}</span>
		</div>
	);
}

const DIM_FOR_STATUS: Readonly<Record<PrimeSubagentRecord["status"], string>> = {
	RUNNING: COLOR_RUNNING,
	DONE: COLOR_PASS,
	ERROR: COLOR_FAIL,
};
