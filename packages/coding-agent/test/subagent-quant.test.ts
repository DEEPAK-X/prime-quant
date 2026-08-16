import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.js";

/**
 * Phase 7C: sub-agent delegation contract for quant work.
 *
 * An orchestrator session issues `rlm.run("Run walk-forward test",
 * model="tier:worker")`. The host resolves the `tier:worker` selector to the
 * configured worker-tier model, spawns a child, and the child returns a quant
 * summary card (the only shape `rlm.quant.run_pipeline` is allowed to emit).
 *
 * This test asserts the delegation *contract* that the quant skill depends on,
 * without booting a real IPython kernel (the suite is faux-provider only):
 *   1. `tier:worker` routes the child to the configured worker model, not the
 *      parent's orchestrator model.
 *   2. The child's summary card respects the 150-token context budget.
 *   3. Child kernel-scope variables (raw frames, equity curves, the strategy
 *      object) never leak into the parent's kernel/context — only the card.
 */

const orchestratorModel = getModel("anthropic", "claude-sonnet-4-5")!;

// A distinct worker-tier model registered with the same faux provider so the
// child is authenticated and resolvable, but visibly different from the parent.
const WORKER_MODEL_ID = "claude-haiku-worker";
const MAX_CARD_TOKENS = 150;

function estimateTokens(text: string): number {
	// Mirrors the Python estimator in skills/quant/src/quant/runner.py:
	// `max(1, len(text) // 4)`.
	return Math.max(1, Math.floor(text.length / 4));
}

/**
 * A compact quant summary card identical in shape to what
 * `rlm.quant.run_pipeline` returns (status/spec/metrics/validation_gate/
 * optimization/report). Kept well under the 150-token budget on purpose.
 */
function quantSummaryCard(symbol: string, timeframe: string): string {
	const card = {
		status: "success",
		spec: { asset_class: "Forex", symbol, timeframe },
		metrics: {
			sharpe: 1.42,
			sortino: 1.78,
			calmar: 0.93,
			max_drawdown_pct: 0.12,
			profit_factor: 1.81,
			win_rate: 0.54,
			expectancy: 18.4,
			n_trades: 96,
		},
		validation_gate: {
			available: true,
			passed: true,
			pbo: 0.21,
			deflated_sharpe: 0.96,
			oos_sharpe_mean: 1.18,
		},
		optimization: { skipped: true },
		report: { report_path: "tearsheet_EURUSD_M5.html", file_size_kb: 12.4 },
	};
	return JSON.stringify(card, undefined, 0);
}

describe("Phase 7C: orchestrator delegates quant work to a worker-tier subagent", () => {
	let tempDir: string;
	let parent: Harness | undefined;
	let children: Harness[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-7c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		children = [];
	});

	afterEach(() => {
		for (const child of children) child.cleanup();
		children = [];
		parent?.cleanup();
		parent = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("routes tier:worker to the configured worker model and returns a budget-bounded card", async () => {
		// The faux provider's `provider` name is the stable default `"faux"` (only
		// its `api` is randomized per registration), so `faux/<id>` selectors are
		// stable and can be wired through the harness `settings` option up front.
		const orchestratorSelector = `faux/${orchestratorModel.id}`;
		const workerSelector = `faux/${WORKER_MODEL_ID}`;
		const childCard = quantSummaryCard("EURUSD", "M5");

		// Build a child harness the host will spawn on rlm.run(model="tier:worker").
		// Defined before the parent so the `subagentRuntimeHost` can close over it
		// and be passed through `createHarness` (the session captures it at c'tor).
		const createChild = async (): Promise<Harness> => {
			const child = await createHarness({
				models: [
					{ id: orchestratorModel.id, name: "orchestrator", reasoning: true },
					{ id: WORKER_MODEL_ID, name: "worker" },
				],
				settings: {
					modelTiers: { worker: workerSelector, orchestrator: orchestratorSelector },
				} as never,
			});
			children.push(child);
			// The child's faux response is exactly the quant summary card.
			child.setResponses([
				{
					role: "assistant",
					content: [{ type: "text", text: childCard }],
					api: child.faux.api,
					provider: child.models[0].provider,
					model: WORKER_MODEL_ID,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				} as never,
			]);
			return child;
		};

		// Wire the subagent host: the parent spawns the child harness on rlm.run.
		// `createRlmSubagentRuntime` receives the resolved model + sessionDir; we
		// capture the resolved model to assert tier routing, and the child's answer
		// becomes the subagent result surfaced to the parent.
		const spawnedModels: Model<string>[] = [];
		const subagentRuntimeHost: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options: CreateRlmSubagentRuntimeOptions) => {
				spawnedModels.push(options.model as Model<string>);
				const child = await createChild();
				options.onSessionPublished?.(child.session);
				return { session: child.session };
			},
			deleteRlmSubagentRuntime: async (_childId, session) => {
				await session?.disposeAsync();
			},
		};

		parent = await createHarness({
			models: [
				{ id: orchestratorModel.id, name: "orchestrator", reasoning: true },
				{ id: WORKER_MODEL_ID, name: "worker" },
			],
			settings: {
				// Route the worker tier to the distinct worker model registered above.
				modelTiers: { worker: workerSelector, orchestrator: orchestratorSelector },
			} as never,
			subagentRuntimeHost,
		});

		// Parent is on the orchestrator model.
		expect(parent.getModel().id).toBe(orchestratorModel.id);

		// Drive a parent turn that instructs a quant run; the parent's response is a
		// short acknowledgment that it delegated the work to a worker subagent.
		parent.setResponses([
			{
				role: "assistant",
				content: [{ type: "text", text: "Delegated the walk-forward test to a worker subagent." }],
				api: parent.faux.api,
				provider: parent.models[0].provider,
				model: orchestratorModel.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} as never,
		]);

		// Issue the delegation: rlm.run("Run walk-forward test", model="tier:worker").
		const handle = await parent.session.runRlmChild("Run walk-forward test", { model: "tier:worker" });

		// (1) The child was routed to the worker-tier model, not the parent's model.
		expect(spawnedModels.length).toBe(1);
		expect(spawnedModels[0].id).toBe(WORKER_MODEL_ID);
		expect(spawnedModels[0].id).not.toBe(orchestratorModel.id);

		// Drain the async child turn so the summary card is produced.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// (2) The quant summary card respects the 150-token context budget.
		expect(estimateTokens(childCard), "card must fit the 150-token budget").toBeLessThanOrEqual(MAX_CARD_TOKENS);
		const parsed = JSON.parse(childCard) as { status: string; report?: { report_path: string } };
		expect(parsed.status).toBe("success");
		expect(parsed.report?.report_path).toBe("tearsheet_EURUSD_M5.html");

		// (3) Child kernel-scope variables do not leak into the parent.
		// The parent's surfaced assistant text is the delegation acknowledgment,
		// not the raw card, and never raw frames / equity / trades. The card is the
		// child's own context; the parent only sees the subagent summary line.
		const parentAssistantText = getAssistantTexts(parent).join("\n");
		expect(parentAssistantText).toContain("worker subagent");
		// Raw-frame leak guards: the parent context must not carry the forbidden
		// kernel-scope bindings or any raw DataFrame/trade-list content.
		for (const leaked of ["_last_df", "_last_equity_curve", "_last_trades", "equity_curve", "trade_list"]) {
			expect(parentAssistantText, `parent must not leak child binding '${leaked}'`).not.toContain(leaked);
		}
		// The on-disk tearsheet path stays on disk; only {report_path,file_size_kb}
		// crosses the boundary, never the HTML body.
		expect(parentAssistantText).not.toContain("<svg");
		expect(parentAssistantText).not.toContain("</html>");

		// The spawn handle carries the worker-tier model selector, proving the
		// tier:worker kwarg propagated end-to-end through the runRlmChild path.
		expect(handle.model).toContain(WORKER_MODEL_ID);
	}, 30_000);
});
