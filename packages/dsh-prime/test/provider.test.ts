import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostContext, PrimeSubagentProvider } from "../src/dsh-types.js";
import { apply } from "../src/host/index.js";
import { PrimeRpcPool } from "../src/host/pool.js";
import { MISSING_CLI_ERROR, PrimeRpcProvider } from "../src/host/provider.js";
import { createRpcHarness, drive, type RpcHarness, respond, settle } from "./fake-rpc.js";

describe("PrimeRpcProvider", () => {
	let pool: PrimeRpcPool | undefined;
	let harness: RpcHarness;

	afterEach(async () => {
		await pool?.stop();
		pool = undefined;
	});

	function makePool(): PrimeRpcPool {
		harness = createRpcHarness();
		const workspace = mkdtempSync(join(tmpdir(), "dsh-provider-"));
		pool = new PrimeRpcPool({
			workspace,
			cliPath: join(workspace, "cli.js"),
			spawn: harness.spawn,
			commandTimeoutMs: 1000,
			sessionDir: join(workspace, ".sessions"),
		});
		return pool;
	}

	it("start prompts the fake child and returns completed assistant text", async () => {
		const p = makePool();
		const provider = new PrimeRpcProvider({ pool: p, cliPath: "/fake/cli.js" });
		const runPromise = provider.start({ text: "test this strategy on MT5" });
		await settle();
		const child = harness.children[0]!;
		respond(child);
		const run = await runPromise;
		await settle();
		drive(child, { type: "message_start", message: { role: "assistant", timestamp: 1 } });
		drive(child, {
			type: "message_end",
			message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "gate passed" }] },
		});
		respond(child);
		await settle();
		const result = await run.result;
		expect(result.stopReason).toBe("completed");
		expect(result.output).toBe("gate passed");
	});

	it("start without a cli path fails with the frozen error and does not spawn", async () => {
		const p = makePool();
		const provider = new PrimeRpcProvider({ pool: p, cliPath: undefined });
		const before = harness.spawnCalls.length;
		await expect(provider.start({ text: "go" })).rejects.toThrow(MISSING_CLI_ERROR);
		expect(harness.spawnCalls).toHaveLength(before);
	});

	it("dispose while running sends abort", async () => {
		const p = makePool();
		const provider = new PrimeRpcProvider({ pool: p, cliPath: "/fake/cli.js" });
		const runPromise = provider.start({ text: "long run" });
		await settle();
		respond(harness.children[0]!);
		const run = await runPromise;
		await settle();
		const disposePromise = run.dispose();
		await settle();
		respond(harness.children[0]!);
		await disposePromise;
		await pool!.stop();
	});

	it("apply registers the provider and does not spawn", () => {
		harness = createRpcHarness();
		const registered: PrimeSubagentProvider[] = [];
		const ctx: HostContext = {
			subagents: {
				register(name, provider) {
					expect(name).toBe("prime");
					registered.push(provider);
				},
			},
		};
		const result = apply(ctx);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.inheritsParentContext).toBe(false);
		expect(harness.spawnCalls).toHaveLength(0);
		void result.dispose();
	});

	it("fiber dispose stops the pool", async () => {
		const p = makePool();
		const ensure = p.ensure();
		await settle();
		respond(harness.children[0]!);
		await ensure;
		expect(p.getAgentState()).toBe("ready");
		await p.stop();
		expect(p.getAgentState()).toBe("stopped");
	});
});
