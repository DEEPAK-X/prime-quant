import process from "node:process";

import { resolvePrimeCli } from "../resolve-cli.js";

/**
 * Fill stock dsh-subagent-acp command/args (docs/dsh-adapter/03 A5).
 * C enables the YAML row locally; this helper is the only path that should
 * produce the argv. Committed cordis.patch.yml keeps the row disabled.
 */
export function resolveAcpChild(start?: string): { command: string; args: string[] } | undefined {
	const cli = resolvePrimeCli(start);
	if (!cli) return undefined;
	return { command: process.execPath, args: [cli, "--mode", "acp"] };
}
