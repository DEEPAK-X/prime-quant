import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CardView } from "../views/CardView.js";
import { StepView } from "../views/StepView.js";
import { TearsheetView } from "../views/TearsheetView.js";
import { SubagentView } from "../views/SubagentView.js";
import { SettingsView } from "../views/SettingsView.js";
import type { PrimeCardRecord } from "../nodes/card.js";
import type { PrimeStepRecord } from "../nodes/step.js";
import type { PrimeTearsheetRecord } from "../nodes/tearsheet.js";
import type { PrimeSubagentRecord } from "../nodes/subagent.js";

const card: PrimeCardRecord = {
	cardId: "c-run-1",
	title: "Backtest · EURUSD M5",
	payload: {
		status: "success",
		metrics: { sharpe_ratio: 1.84 },
		validation_gate: { passed: true, dsr_min: 1.2 },
	},
};

const runningStep: PrimeStepRecord = { stepId: "s1", name: "backtest", status: "running", detail: "sharpe 1.2" };
const tearsheet: PrimeTearsheetRecord = {
	url: "/prime-reports/tearsheet_EURUSD_M5.html",
	name: "tearsheet_EURUSD_M5.html",
	ts: undefined,
};
const subagent: PrimeSubagentRecord = {
	id: "sub-1",
	name: "worker://eurusd-m5-scan",
	tier: "worker",
	status: "DONE",
	task: "param sweep",
};

describe("CardView static markup", () => {
	const html = renderToStaticMarkup(createElement(CardView, { card }));

	it("renders the metric grid with pretty labels and formatted values", () => {
		expect(html).toContain("sharpe ratio");
		expect(html).toContain("1.84");
	});

	it("renders a PASS verdict for a passed gate", () => {
		expect(html).toContain(">PASS</span>");
		expect(html).toContain("#3fb950");
	});

	it("keeps the raw payload behind the collapsed toggle", () => {
		expect(html).toContain("raw payload");
		expect(html).not.toContain("validation_gate");
	});
});

describe("StepView static markup", () => {
	it("renders the status icon, canonical label, and detail tooltip", () => {
		const html = renderToStaticMarkup(createElement(StepView, { step: runningStep }));
		expect(html).toContain("◐");
		expect(html).toContain("Backtest");
		expect(html).toContain('title="sharpe 1.2"');
		expect(html).toContain("#d29922");
	});
});

describe("TearsheetView static markup", () => {
	const html = renderToStaticMarkup(createElement(TearsheetView, { tearsheet }));

	it("asserts the iframe src prop and sandbox without allow-scripts", () => {
		expect(html).toContain('src="/prime-reports/tearsheet_EURUSD_M5.html"');
		expect(html).toContain('sandbox="allow-same-origin"');
		expect(html).not.toContain("allow-scripts");
	});

	it("links out with target=_blank rel=noopener noreferrer", () => {
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('target="_blank"');
	});
});

describe("SubagentView static markup", () => {
	const html = renderToStaticMarkup(createElement(SubagentView, { subagent }));

	it("renders name, tier badge, task, and status dot", () => {
		expect(html).toContain("worker://eurusd-m5-scan");
		expect(html).toContain("worker</span>");
		expect(html).toContain("param sweep");
		expect(html).toContain('aria-label="subagent DONE"');
		expect(html).toContain("#3fb950");
	});
});

describe("SettingsView static markup", () => {
	it("shows the placeholder cli path and enable-tool copy before any fetch resolves", () => {
		const html = renderToStaticMarkup(createElement(SettingsView));
		expect(html).toContain("Prime Agent");
		expect(html).toContain("resolved at runtime by host glue");
		expect(html).toContain("Enable the tool in Plugins if it is disabled.");
	});
});
