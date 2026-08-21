import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const CLI_REL = ["packages", "coding-agent", "dist", "bundle", "cli.js"] as const;

/**
 * Walk up from `start` looking for `<dir>/packages/coding-agent/dist/bundle/cli.js`.
 * Same loop shape as findPreviewBridge (gui-launch.ts); this package must not import that file.
 */
export function resolvePrimeCli(start: string = process.cwd()): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = resolve(dir, ...CLI_REL);
		if (existsSync(candidate)) return candidate;
		const parent = resolve(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export const MISSING_CLI_ERROR =
	"Prime Agent bundle not found (expected packages/coding-agent/dist/bundle/cli.js). Run from a Prime Quant checkout.";
