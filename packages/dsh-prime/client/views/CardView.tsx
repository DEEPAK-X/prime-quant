/**
 * prime/card renderer: title row, metric grid, PASS/FAIL verdict row,
 * collapsed raw-JSON toggle. Visual language mirrors web-ui QuantCard
 * (copied ideas, no Vite imports); DSH chrome stays DSH.
 */

import { useState } from "react";
import type { PrimeCardRecord } from "../nodes/card.js";
import { formatMetricValue, prettyLabel, summarizeGate } from "../lib/gate.js";

const COLOR_BORDER = "#30363d";
const COLOR_FG = "#e6edf3";
const COLOR_DIM = "#8b949e";
const COLOR_BG = "#0d1117";
const COLOR_PASS = "#3fb950";
const COLOR_FAIL = "#f85149";

function verdictStyle(passed: boolean | undefined): React.CSSProperties {
	if (passed === true) return { borderColor: COLOR_PASS, color: COLOR_PASS };
	if (passed === false) return { borderColor: COLOR_FAIL, color: COLOR_FAIL };
	return { borderColor: COLOR_BORDER, color: COLOR_DIM };
}

function verdictLabel(passed: boolean | undefined): string {
	if (passed === true) return "PASS";
	if (passed === false) return "FAIL";
	return "UNKNOWN";
}

export interface CardViewProps {
	readonly card: PrimeCardRecord;
}

export function CardView({ card }: CardViewProps) {
	const [open, setOpen] = useState(false);
	const gate = summarizeGate(card.payload);
	const metrics = Object.entries(
		typeof card.payload.metrics === "object" && card.payload.metrics !== null ? card.payload.metrics : {},
	);
	const status = typeof card.payload.status === "string" ? card.payload.status : undefined;

	return (
		<div style={{ border: `1px solid ${COLOR_BORDER}`, background: COLOR_BG, maxWidth: 480, fontSize: 12 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					borderBottom: `1px solid ${COLOR_BORDER}`,
					padding: "5px 8px",
				}}
			>
				<span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLOR_FG }}>
					{card.title}
				</span>
				{status !== undefined ? (
					<span style={{ flexShrink: 0, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_DIM }}>
						{status}
					</span>
				) : null}
			</div>

			{metrics.length > 0 ? (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1, background: COLOR_BORDER }}>
					{metrics.map(([label, value]) => (
						<div key={label} style={{ background: COLOR_BG, padding: "5px 8px" }}>
							<div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_DIM }}>
								{prettyLabel(label)}
							</div>
							<div style={{ fontSize: 14, color: COLOR_FG }}>{formatMetricValue(value)}</div>
						</div>
					))}
				</div>
			) : null}

			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					borderTop: `1px solid ${COLOR_BORDER}`,
					padding: "5px 8px",
				}}
			>
				<span style={{ fontSize: 10, color: COLOR_DIM }}>
					{gate.entries.map((entry) => `${entry.label} ${entry.value}`).join(" · ")}
				</span>
				<span
					style={{
						border: "1px solid",
						padding: "1px 6px",
						fontSize: 10,
						textTransform: "uppercase",
						letterSpacing: "0.08em",
						...verdictStyle(gate.passed),
					}}
				>
					{verdictLabel(gate.passed)}
				</span>
			</div>

			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={open ? "Collapse raw payload" : "Expand raw payload"}
				style={{
					display: "flex",
					width: "100%",
					alignItems: "center",
					gap: 6,
					borderTop: `1px solid ${COLOR_BORDER}`,
					padding: "3px 8px",
					background: "transparent",
					color: COLOR_DIM,
					fontSize: 10,
					textTransform: "uppercase",
					letterSpacing: "0.08em",
					cursor: "pointer",
					textAlign: "left",
				}}
			>
				{open ? "▾" : "▸"} raw payload
			</button>
			{open ? (
				<pre
					style={{
						maxHeight: 192,
						overflow: "auto",
						margin: 0,
						borderTop: `1px solid ${COLOR_BORDER}`,
						padding: "5px 8px",
						fontSize: 10,
						lineHeight: 1.5,
						color: COLOR_DIM,
					}}
				>
					{JSON.stringify(card.payload, null, 2)}
				</pre>
			) : null}
		</div>
	);
}
