import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { buildRlmPrompt } from "../src/core/prompts/rlm.js";
import { buildRlmBootstrapCode } from "../src/core/tools/ipython.js";

describe("IPython RLM bootstrap", () => {
	it("pre-imports asyncio so the prompt's subagent patterns work without a manual import", () => {
		expect(buildRlmBootstrapCode()).toMatch(/^import asyncio$/m);
	});

	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain('async def find_models(self, query="", limit=8)');
		expect(code).toContain("async def list_subagents(self)");
		expect(code).toContain("async def delete_subagent(self, target)");
		expect(code).toContain("self._raise_missing()");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('_prime_agent_os.environ["NO_COLOR"] = "1"');
	});

	it("guards Python skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("except Exception as _prime_agent_skill_error");
		expect(code).toContain("_PrimeAgentUnavailableSkill");
		expect(code).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS");
		expect(code).toContain("globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill");
	});

	it("registers the quant skill bundle as rlm.quant with a guarded import", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("import quant as _prime_agent_quant_skill");
		expect(code).toContain("rlm.quant = _prime_agent_quant_skill");
		expect(code).toContain('hasattr(_prime_agent_quant_skill, "run_backtest")');
		expect(code).toMatch(/except Exception as _prime_agent_quant_skill_error/);
	});

	it("documents the rlm.quant context-compression contract in the RLM prompt", () => {
		const prompt = buildRlmPrompt({
			cwd: "/tmp",
			messagesPath: "/tmp/conv.jsonl",
			installedSkills: ["quant"],
			activeTools: ["ipython"],
		});
		expect(prompt).toContain("rlm.quant");
		expect(prompt).toContain("run_backtest");
		expect(prompt).toContain("_last_backtest_df");
		expect(prompt).toContain("refine_log_failure");
	});
});

/** Find a python that can launch an ipykernel, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("IPython RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-bootstrap-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds asyncio in the user namespace", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute("_t = asyncio.create_task(asyncio.sleep(0))\nprint(type(_t).__name__)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("Task");

			const bashResult = await manager.execute('%%bash\nprintf %s "$NO_COLOR"');
			expect(bashResult.status).toBe("ok");
			expect(bashResult.stdout).toBe("1");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("emits canonical paths for edits after the kernel changes directories", async () => {
		const firstDir = join(dir, "first");
		const secondDir = join(dir, "second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(firstDir, "same.txt"), "old");
		writeFileSync(join(secondDir, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			env: { PYTHONPATH: join(editSkillRoot, "src") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "edit",
						importName: "edit",
						packagePath: editSkillRoot,
						pyprojectPath: join(editSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const first = await manager.execute(
				'import os\nos.chdir("first")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);
			const second = await manager.execute(
				'os.chdir("../second")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);

			expect(first.diffs?.[0]?.path).toBe(realpathSync(join(firstDir, "same.txt")));
			expect(second.diffs?.[0]?.path).toBe(realpathSync(join(secondDir, "same.txt")));
			expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});

const quantSkillRoot = join(process.cwd(), "skills", "quant");
const quantSkillSrc = join(quantSkillRoot, "src");
const primeQuantSrc = join(process.cwd(), "prime-quant", "src");
const quantEnv = { ...process.env, PYTHONPATH: [quantSkillSrc, primeQuantSrc].join(delimiter) };
const quantKernelReady =
	python !== null &&
	spawnSync(python, ["-c", "import polars, numpy, primequant, quant"], {
		env: quantEnv,
		encoding: "utf8",
	}).status === 0;

const describeIfQuantKernel = quantKernelReady ? describe : describe.skip;

describeIfQuantKernel("IPython RLM bootstrap (quant skill bundle)", () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-quant-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("runs a backtest through rlm.quant and compresses output to a card", async () => {
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			env: quantEnv,
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "quant",
						importName: "quant",
						packagePath: quantSkillRoot,
						pyprojectPath: join(quantSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const run = await manager.execute(
				[
					"import polars as pl",
					"from datetime import datetime, timedelta",
					"n = 200",
					"times = [datetime(2024, 1, 1) + timedelta(hours=i) for i in range(n)]",
					"close = [1.1 + i * 0.0001 for i in range(n)]",
					"df = pl.DataFrame({",
					'    "time": times, "open": close,',
					'    "high": [c + 0.0002 for c in close],',
					'    "low": [c - 0.0002 for c in close],',
					'    "close": close, "volume": [100.0] * n,',
					"})",
					'card = await rlm.quant.run_backtest("EURUSD M5 sma cross", data=df)',
					"print(card)",
				].join("\n"),
			);
			expect(run.status).toBe("ok");

			const lastLine = run.stdout.trim().split(/\n/).filter(Boolean).pop() ?? "";
			const card = JSON.parse(lastLine);
			expect(card.status).toBe("success");
			expect(card.spec).toEqual({ asset_class: "Forex", symbol: "EURUSD", timeframe: "M5" });
			expect(typeof card.metrics.sharpe_ratio).toBe("number");
			expect(card.metrics.trades_count).toBeGreaterThan(0);
			// Real validation is active: the gate reports CPCV/walk-forward results.
			expect(card.validation_gate.available).toBe(true);
			expect(typeof card.validation_gate.passed).toBe("boolean");
			expect(typeof card.validation_gate.deflated_sharpe).toBe("number");
			expect(typeof card.validation_gate.pbo).toBe("number");
			// Context compression: the card must respect the 150-token budget.
			expect(lastLine.length / 4).toBeLessThanOrEqual(150);

			// Raw frames stay bound in the kernel scope for subagent inspection.
			const bound = await manager.execute(
				"print(len(_last_equity_curve), len(_last_backtest_df), len(_last_trades))",
			);
			expect(bound.status).toBe("ok");
			expect(bound.stdout.split(/\s+/).filter(Boolean)).toHaveLength(3);
		} finally {
			await manager.dispose();
		}
	}, 90_000);
});
