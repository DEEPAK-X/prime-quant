import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PoolBusyError, PrimeRpcPool } from "../src/host/pool.js";
import { createRpcHarness, drive, type RpcHarness, respond, settle, writtenLines } from "./fake-rpc.js";

describe("PrimeRpcPool", () => {
	let pool: PrimeRpcPool | undefined;
	let harness: RpcHarness;

	afterEach(async () => {
		await pool?.stop();
		pool = undefined;
	});

	async function startPool(): Promise<void> {
		harness = createRpcHarness();
		const workspace = mkdtempSync(join(tmpdir(), "dsh-pool-"));
		pool = new PrimeRpcPool({
			workspace,
			cliPath: join(workspace, "cli.js"),
			spawn: harness.spawn,
			commandTimeoutMs: 1000,
			sessionDir: join(workspace, ".sessions"),
		});
		const ensure = pool.ensure();
		await settle();
		respond(harness.children[0]!);
		await ensure;
	}

	it("ensure is idempotent: one spawn, ready after get_state", async () => {
		await startPool();
		expect(pool!.getAgentState()).toBe("ready");
		await pool!.ensure();
		await pool!.ensure();
		expect(harness.children).toHaveLength(1);
		expect(writtenLines(harness.children[0]!)[0]).toContain('"type":"get_state"');
	});

	it("rejects a second prompt while the session is busy", async () => {
		await startPool();
		const child = harness.children[0]!;
		drive(child, { type: "agent_start" });
		await settle();
		expect(pool!.isBusy()).toBe(true);
		await expect(pool!.prompt("second")).rejects.toBeInstanceOf(PoolBusyError);
	});

	it("abort sends RPC abort; stop is idempotent", async () => {
		await startPool();
		const child = harness.children[0]!;
		const abortPromise = pool!.abort();
		await settle();
		respond(child);
		await abortPromise;
		expect(writtenLines(child).some((line) => line.includes('"type":"abort"'))).toBe(true);
		await pool!.stop();
		await pool!.stop();
		expect(pool!.getAgentState()).toBe("stopped");
	});
});
