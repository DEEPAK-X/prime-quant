/**
 * Quant result card: title row, metric grid, validation-gate verdict row
 * (PASS green / FAIL red / unknown gray), collapsible raw JSON payload.
 *
 * Renders a `card` event. The validation verdict derives from
 * `payload.validation_gate.passed` (true → PASS, false → FAIL, absent/undefined
 * → unknown). Metrics render label (small caps) over value (large). The full
 * payload is available behind a collapsible raw-JSON panel for inspection.
 */
import { useState } from "react";
import type { CardEvent } from "../lib/ws";

interface QuantCardProps {
	readonly card: CardEvent;
}

function verdictStyle(passed: boolean | undefined): string {
	if (passed === true) return "border-term-green text-term-green";
	if (passed === false) return "border-term-red text-term-red";
	return "border-term-border text-term-dim";
}

function verdictLabel(passed: boolean | undefined): string {
	if (passed === true) return "PASS";
	if (passed === false) return "FAIL";
	return "PENDING";
}

function formatValue(value: number | string | boolean | null | undefined): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (Number.isInteger(value)) return value.toString();
		return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
	}
	return value;
}

function prettyLabel(label: string): string {
	return label.replace(/_/g, " ");
}

export function QuantCard({ card }: QuantCardProps) {
	const [open, setOpen] = useState(false);
	const gate = card.payload.validation_gate;
	const metrics = card.payload.metrics ?? {};
	const metricEntries = Object.entries(metrics);
	const gateEntries = gate
		? Object.entries(gate).filter(([label]) => label !== "passed")
		: [];

	return (
		<div className="border border-term-border bg-term-bg" style={{ borderRadius: "var(--radius-term-card)" }}>
			<div className="flex items-center justify-between border-b border-term-border px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-xs text-term-fg">{card.title}</span>
				{card.payload.status ? (
					<span className="shrink-0 text-[10px] uppercase tracking-wider text-term-dim">{card.payload.status}</span>
				) : null}
			</div>

			{metricEntries.length > 0 ? (
				<div className="grid grid-cols-3 gap-px bg-term-border sm:grid-cols-4">
					{metricEntries.map(([label, value]) => (
						<div key={label} className="bg-term-bg px-2 py-1.5">
							<div className="text-[9px] uppercase tracking-wider text-term-dim">{prettyLabel(label)}</div>
							<div className="text-sm text-term-fg">{formatValue(value)}</div>
						</div>
					))}
				</div>
			) : null}

			<div className="flex items-center justify-between border-t border-term-border px-2 py-1.5">
				<div className="flex items-center gap-1.5">
					<span className="text-[9px] uppercase tracking-wider text-term-dim">validation</span>
					{gateEntries.length > 0 ? (
						<span className="text-[10px] text-term-dim">
							{gateEntries.map(([label, value]) => `${prettyLabel(label)} ${formatValue(value)}`).join(" · ")}
						</span>
					) : null}
				</div>
				<span
					className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${verdictStyle(gate?.passed)}`}
				>
					{verdictLabel(gate?.passed)}
				</span>
			</div>

			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={open ? "Collapse raw payload" : "Expand raw payload"}
				className="flex w-full items-center gap-1.5 border-t border-term-border px-2 py-1 text-left hover:bg-term-panel"
			>
				<span className="text-[10px] text-term-dim">{open ? "▾" : "▸"}</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">raw payload</span>
			</button>
			{open ? (
				<pre className="max-h-48 overflow-auto border-t border-term-border px-2 py-1.5 text-[10px] leading-relaxed text-term-dim">
					{JSON.stringify(card.payload, null, 2)}
				</pre>
			) : null}
		</div>
	);
}
