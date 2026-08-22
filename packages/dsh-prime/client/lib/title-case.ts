/** Step label rendering: canonical labels for known pipeline steps, title-case fallback. */

const KNOWN_STEP_LABELS: Readonly<Record<string, string>> = {
	ast_check: "AST check",
	backtest: "Backtest",
	cpcv_gate: "CPCV gate",
	optimize: "Optimize",
	tearsheet: "Tearsheet",
	fetch_data: "Fetch data",
};

/** Uppercase the first letter of every space-separated word; keeps separators. */
export function titleCase(value: string): string {
	const trimmed = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
	if (trimmed === "") return value;
	return trimmed
		.split(" ")
		.map((word) => (word === "" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
}

/** Display label for a prime/step name; unknown names are title-cased. */
export function stepLabel(name: string): string {
	return KNOWN_STEP_LABELS[name] ?? titleCase(name);
}
