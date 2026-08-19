/**
 * A3 watcher service: preset parsing from the quant skill bundle, next-run
 * computation for the preset cron forms, and schedule CLI spawn/cancel/list
 * through an injected runner (no real CLI in tests).
 */
import { describe, expect, it } from "vitest";
import { type CliRunner, nextRun, parsePreset, WatcherService } from "../src/watchers.js";

const RISK_MD = `# Risk Watcher Preset

The Risk Watcher is a scheduled monitoring agent that periodically inspects portfolio performance.

## Scheduled Command

Schedule with \`prime-agent schedule\`:

\`\`\`bash
prime-agent schedule "*/15 * * * *" "Run the Risk Watcher..."
\`\`\`

## Exact Prompt Template

\`\`\`markdown
You are the PRIME QUANT Risk Watcher.
Check drawdown against limits.
\`\`\`
`;

describe("parsePreset", () => {
	it("extracts title, summary, cron, prompt, and mapped room", () => {
		const preset = parsePreset("risk-watcher", RISK_MD);
		expect(preset).not.toBeNull();
		expect(preset?.title).toBe("Risk Watcher");
		expect(preset?.cron).toBe("*/15 * * * *");
		expect(preset?.room).toBe("risk-management");
		expect(preset?.prompt).toContain("Risk Watcher");
	});

	it("returns null without a prompt template block", () => {
		const broken = RISK_MD.replace(/## Exact Prompt Template[\s\S]*?```/g, "");
		expect(parsePreset("risk-watcher", broken)).toBeNull();
	});
});

describe("nextRun", () => {
	it("computes the next interval for */N minute crons", () => {
		const from = new Date("2026-08-19T12:07:30Z");
		expect(nextRun("*/15 * * * *", from)).toBe("2026-08-19T12:15:00.000Z");
	});

	it("computes specific-minute hourly steps (0 */N)", () => {
		const from = new Date("2026-08-19T12:00:00Z");
		const next = nextRun("0 */4 * * *", from);
		expect(next).toBe("2026-08-19T16:00:00.000Z");
	});

	it("returns null for non-preset cron shapes", () => {
		expect(nextRun("0 9 * * 1-5")).toBeNull();
	});
});

describe("WatcherService", () => {
	function createRunner(calls: string[][]): CliRunner {
		return async (args) => {
			calls.push(args);
			if (args[0] === "schedule" && args[1] === "list") {
				return {
					code: 0,
					output: JSON.stringify({
						jobs: [{ id: "job-7", agent: "worker", schedule: "*/15 * * * *", message: "risk" }],
					}),
				};
			}
			return { code: 0, output: "ok" };
		};
	}

	it("spawn/cancel/list go through the real schedule CLI", async () => {
		const calls: string[][] = [];
		const service = new WatcherService("/tmp/bundle.js", createRunner(calls));

		const spawned = await service.spawn("*/15 * * * *", "prompt");
		expect(spawned.ok).toBe(true);
		expect(calls[0]).toEqual(["schedule", "add", "worker", "*/15 * * * *", "--", "prompt"]);

		const active = await service.list();
		expect(active).toHaveLength(1);
		expect(active[0].jobId).toBe("job-7");
		expect(active[0].nextRunAt).not.toBeNull();

		const cancelled = await service.cancel("job-7");
		expect(cancelled.ok).toBe(true);
		expect(calls[2]).toEqual(["schedule", "cancel", "job-7"]);
	});
});
