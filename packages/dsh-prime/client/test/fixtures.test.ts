import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface FixtureLine {
	type: string;
	data?: Record<string, unknown>;
}

const FIXTURES = join(__dirname, "..", "..", "fixtures");

function readJsonl(name: string): FixtureLine[] {
	const raw = readFileSync(join(FIXTURES, name), "utf8");
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	return lines.map((line, index) => {
		const parsed = JSON.parse(line) as FixtureLine;
		if (typeof parsed.type !== "string" || parsed.type.length === 0) {
			throw new Error(`${name}:${index + 1} is not a SessionEvent-shaped object`);
		}
		return parsed;
	});
}

describe("fixtures parse as JSONL", () => {
	it("turn-backtest.jsonl has 5 prime/step lines plus card/tearsheet/subagent", () => {
		const events = readJsonl("turn-backtest.jsonl");
		expect(events.filter((event) => event.type === "prime/step")).toHaveLength(5);
		expect(events.filter((event) => event.type === "prime/card")).toHaveLength(1);
		expect(events.filter((event) => event.type === "prime/tearsheet")).toHaveLength(1);
		expect(events.filter((event) => event.type === "prime/subagent")).toHaveLength(1);
	});

	it("turn-interrupt.jsonl leaves an open running step with no done", () => {
		const steps = readJsonl("turn-interrupt.jsonl").filter((event) => event.type === "prime/step");
		const byId = new Map<string, string>();
		for (const step of steps) {
			const data = step.data as { stepId?: unknown; status?: unknown };
			if (typeof data.stepId === "string" && typeof data.status === "string") {
				byId.set(data.stepId, data.status);
			}
		}
		expect(byId.get("run-2-opt")).toBe("running");
		expect(byId.get("run-2-fetch")).toBe("done");
	});

	it("turn-mt5-down.jsonl has one prime/mt5 down event", () => {
		const events = readJsonl("turn-mt5-down.jsonl");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("prime/mt5");
		expect((events[0]?.data as { status?: unknown }).status).toBe("down");
	});
});
