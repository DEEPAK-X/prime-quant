/** Validation-gate summary for the quant card verdict row (PASS/FAIL/unknown). */

export interface MetricEntry {
	readonly label: string;
	readonly value: string;
}

export interface GateSummary {
	/** `payload.validation_gate.passed`; undefined when the gate is absent or malformed. */
	readonly passed: boolean | undefined;
	/** Non-`passed` gate entries, formatted for the validation row. */
	readonly entries: readonly MetricEntry[];
}

export function formatMetricValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "—";
		if (Number.isInteger(value)) return value.toString();
		return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
	}
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function prettyLabel(label: string): string {
	return label.replace(/_/g, " ");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Read the validation gate off a GUI v2 card payload. */
export function summarizeGate(payload: Record<string, unknown>): GateSummary {
	const gate = recordOf(payload.validation_gate);
	if (!gate) return { passed: undefined, entries: [] };
	const passed = typeof gate.passed === "boolean" ? gate.passed : undefined;
	const entries = Object.entries(gate)
		.filter(([label]) => label !== "passed")
		.map(([label, value]) => ({ label: prettyLabel(label), value: formatMetricValue(value) }));
	return { passed, entries };
}
