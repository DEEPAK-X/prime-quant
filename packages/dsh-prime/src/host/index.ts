import type { HostContext } from "../dsh-types.js";
import { resolvePrimeCli } from "../resolve-cli.js";
import { createPrimeGlue } from "./glue.js";
import { PrimeRpcPool } from "./pool.js";
import { PrimeRpcProvider } from "./provider.js";

export type { HostContext, PrimeSubagentProvider, PrimeTransport } from "../dsh-types.js";
export { MISSING_CLI_ERROR, resolvePrimeCli } from "../resolve-cli.js";
export { resolveAcpChild } from "./acp-patch.js";
export { PRIME_PROMPT_SECTION, PRIME_PROMPT_SECTION_ID } from "./glue.js";
export { PoolBusyError, PrimeRpcPool } from "./pool.js";
export { PrimeRpcProvider } from "./provider.js";
export { v2ToPrimeSessionEvents } from "./session-bridge.js";

export interface ApplyResult {
	dispose: () => Promise<void>;
}

/**
 * Cordis host apply. Registers provider `prime`. Does not spawn a Prime child.
 */
export function apply(ctx: HostContext = {}): ApplyResult {
	const cliPath = resolvePrimeCli();
	const workspace = process.cwd();
	const pool = new PrimeRpcPool({
		workspace,
		cliPath: cliPath ?? "missing-cli.js",
	});
	const provider = new PrimeRpcProvider({
		pool,
		cliPath,
		sessions: ctx.sessions,
	});
	ctx.subagents?.register("prime", provider);

	const glue = createPrimeGlue({
		cliPath,
		pool,
		artifactsRoot: workspace,
	});
	glue.applyGlue(ctx);

	const dispose = async () => {
		await pool.stop();
	};
	ctx.effect?.(() => () => {
		void dispose();
	});
	return { dispose };
}
