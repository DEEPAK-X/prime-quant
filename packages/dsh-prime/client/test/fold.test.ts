import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	ChatConversationViewNode,
	ConversationMatchResult,
	ConversationNodeContext,
	ConversationNodeDefinition,
	PrimeSessionEvent,
} from "../dsh-client.js";
import { cardDefinition, foldCard, type PrimeCardRecord } from "../nodes/card.js";
import { foldStep, stepDefinition, type PrimeStepRecord } from "../nodes/step.js";
import { subagentDefinition, type PrimeSubagentRecord } from "../nodes/subagent.js";
import { tearsheetDefinition, type PrimeTearsheetRecord } from "../nodes/tearsheet.js";
import { stepLabel, titleCase } from "../lib/title-case.js";
import { summarizeGate } from "../lib/gate.js";

const FIXTURE = join(__dirname, "..", "..", "fixtures", "turn-backtest.jsonl");

interface FixtureLine {
	type: string;
	data?: Record<string, unknown>;
}

/** Enrich fixture lines with the pinned SessionEvent envelope fields. */
function loadEvents(): PrimeSessionEvent[] {
	return readFileSync(FIXTURE, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line, index) => {
			const parsed = JSON.parse(line) as FixtureLine;
			return { type: parsed.type, data: parsed.data ?? {}, seq: index + 1, time: 0 };
		});
}

const DEFINITIONS = [cardDefinition, stepDefinition, tearsheetDefinition, subagentDefinition];

const NO_READER = { previous: () => undefined };

function contextOf<State>(id: string, state: State | undefined): ConversationNodeContext<State | undefined> & {
	readonly state: State | undefined;
} {
	return { key: `${id}`, kind: id, id, matches: [], start: undefined, state };
}

function matchOf(event: PrimeSessionEvent, matched: ConversationMatchResult): {
	event: PrimeSessionEvent;
	role: "start" | "update";
	location: { kind: "unresolved" };
} {
	return { event, role: matched.role, location: { kind: "unresolved" } };
}

/** State-erased view of a Definition so one generic replay drives all four. */
interface ReplayableDefinition {
	readonly kind: string;
	match(event: PrimeSessionEvent): ConversationMatchResult | null;
	start(event: PrimeSessionEvent): unknown;
	update(event: PrimeSessionEvent, previous: unknown): unknown;
	buildViewNode(state: unknown): ChatConversationViewNode | null;
}

function adapt(definition: ConversationNodeDefinition<unknown>): ReplayableDefinition {
	return {
		kind: definition.kind,
		match: (event) => definition.match(event),
		start: (event) =>
			definition.start(
				contextOf<unknown>(matchedId(definition.kind, event), undefined),
				matchOf(event, definition.match(event) as ConversationMatchResult),
				NO_READER,
			),
		update: (event, previous) =>
			definition.update(
				contextOf<unknown>(matchedId(definition.kind, event), previous),
				matchOf(event, definition.match(event) as ConversationMatchResult),
			),
		buildViewNode: (state) => definition.buildViewNode?.(contextOf<unknown>("x", state)) ?? null,
	};
}

function matchedId(kind: string, event: PrimeSessionEvent): string {
	for (const definition of REPLAYABLE) if (definition.kind === kind) return definition.match(event)?.id ?? "";
	return "";
}

const REPLAYABLE: ReadonlyArray<ReplayableDefinition> = DEFINITIONS.map((definition) =>
	// Test-boundary state erasure: the replay harness drives all four
	// definitions through one unknown-state path.
	adapt(definition as unknown as ConversationNodeDefinition<unknown>),
);

interface ReplayEntry {
	readonly definition: ReplayableDefinition;
	state: unknown;
}

/** Minimal stand-in for the engine: route events into per-id Context state. */
function replay(events: readonly PrimeSessionEvent[]): Map<string, ReplayEntry> {
	const contexts = new Map<string, ReplayEntry>();
	for (const event of events) {
		for (const definition of REPLAYABLE) {
			const matched = definition.match(event);
			if (matched === null) continue;
			const key = `${definition.kind}:${matched.id}`;
			const entry = contexts.get(key);
			if (entry === undefined || matched.role === "start") {
				contexts.set(key, { definition, state: definition.start(event) });
			} else {
				entry.state = definition.update(event, entry.state);
			}
		}
	}
	return contexts;
}

describe("fold replay of turn-backtest.jsonl", () => {
	const contexts = replay(loadEvents());

	it("folds one card with passed === true and sharpe_ratio === 1.84", () => {
		const card = contexts.get("prime-card:c-run-1")?.state as PrimeCardRecord | undefined;
		expect(card).toBeDefined();
		expect(card?.title).toBe("Backtest · EURUSD M5");
		const gate = summarizeGate(card?.payload ?? {});
		expect(gate.passed).toBe(true);
		expect((card?.payload.metrics as Record<string, unknown>).sharpe_ratio).toBe(1.84);
	});

	it("leaves run-1-ast and run-1-bt done and the gate step folded under an unmodified name", () => {
		const stepOf = (stepId: string): PrimeStepRecord => {
			const state = contexts.get(`prime-step:${stepId}`)?.state as PrimeStepRecord | undefined;
			expect(state).toBeDefined();
			return state as PrimeStepRecord;
		};
		expect(stepOf("run-1-ast").status).toBe("done");
		expect(stepOf("run-1-bt").status).toBe("done");
		expect(stepOf("run-1-bt").detail).toBe("sharpe 1.2");
		expect(stepOf("run-1-gate").name).toBe("cpcv_gate");
	});

	it("folds one tearsheet whose url starts with /prime-reports/", () => {
		const tearsheet = [...contexts.values()].find((entry) => entry.definition.kind === "prime-tearsheet")
			?.state as PrimeTearsheetRecord | undefined;
		expect(tearsheet?.url.startsWith("/prime-reports/")).toBe(true);
		expect(tearsheet?.name).toBe("tearsheet_EURUSD_M5.html");
	});

	it("folds subagent sub-1 as DONE", () => {
		const subagent = contexts.get("prime-subagent:sub-1")?.state as PrimeSubagentRecord | undefined;
		expect(subagent?.status).toBe("DONE");
		expect(subagent?.task).toBe("param sweep");
	});

	it("ignores unknown event types", () => {
		const unknown: PrimeSessionEvent[] = [
			{ type: "assistant/chunk", data: {}, seq: 100, time: 0 },
			{ type: "totally/unrelated", data: { prime: true }, seq: 101, time: 0 },
		];
		expect(replay(unknown).size).toBe(0);
		expect(foldCard(undefined, unknown[0] as PrimeSessionEvent)).toBeUndefined();
	});

	it("builds a visible chat view node per folded state", () => {
		for (const key of ["prime-card:c-run-1", "prime-step:run-1-ast", "prime-subagent:sub-1"]) {
			const entry = contexts.get(key);
			const node = entry === undefined ? null : entry.definition.buildViewNode(entry.state);
			expect(node?.target).toBe("chat");
			expect(node?.visibility).toBe("visible");
		}
		const tearsheetEntry = [...contexts.values()].find((entry) => entry.definition.kind === "prime-tearsheet");
		const tearsheetNode =
			tearsheetEntry === undefined ? null : tearsheetEntry.definition.buildViewNode(tearsheetEntry.state);
		expect(typeof (tearsheetNode?.data as PrimeTearsheetRecord).url).toBe("string");
	});
});

describe("step upsert collection", () => {
	it("foldStep upserts by stepId with last status winning across a replay", () => {
		let steps: ReadonlyMap<string, PrimeStepRecord> = new Map<string, PrimeStepRecord>();
		let seq = 0;
		const push = (data: Record<string, unknown>): void => {
			seq += 1;
			steps = foldStep(steps, { type: "prime/step", data, seq, time: 0 });
		};
		push({ stepId: "s1", name: "backtest", status: "running" });
		push({ stepId: "s2", name: "param_sweep", status: "running" });
		push({ stepId: "s1", name: "backtest", status: "error", detail: "boom" });
		push({ stepId: "s2", name: "param_sweep", status: "done" });
		expect(steps.get("s1")?.status).toBe("error");
		expect(steps.get("s2")?.status).toBe("done");
		expect(steps.size).toBe(2);
	});
});

describe("labels and gate summary", () => {
	it("title-cases unknown step names and keeps known labels canonical", () => {
		expect(stepLabel("ast_check")).toBe("AST check");
		expect(stepLabel("param_sweep")).toBe("Param Sweep");
		expect(titleCase("weird-name_here")).toBe("Weird Name Here");
	});

	it("summarizeGate reads passed plus extra entries, or unknown when absent", () => {
		expect(summarizeGate({}).passed).toBeUndefined();
		const gate = summarizeGate({ validation_gate: { passed: false, dsr_min: 1.2, pbo_max: 0.05 } });
		expect(gate.passed).toBe(false);
		expect(gate.entries.map((entry) => entry.label)).toEqual(["dsr min", "pbo max"]);
	});
});
