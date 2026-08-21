import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAcpChild } from "../src/host/acp-patch.js";
import { resolvePrimeCli } from "../src/resolve-cli.js";

function fakeCheckout(): { root: string; cli: string } {
	const root = mkdtempSync(join(tmpdir(), "dsh-prime-cli-"));
	const dir = join(root, "packages", "coding-agent", "dist", "bundle");
	mkdirSync(dir, { recursive: true });
	const cli = join(dir, "cli.js");
	writeFileSync(cli, "");
	return { root, cli };
}

describe("resolvePrimeCli", () => {
	it("finds the bundle by walking up from a nested directory", () => {
		const { root, cli } = fakeCheckout();
		const nested = join(root, "packages", "dsh-prime", "src", "host");
		mkdirSync(nested, { recursive: true });
		expect(resolvePrimeCli(nested)).toBe(cli);
		expect(resolvePrimeCli(root)).toBe(cli);
	});

	it("returns undefined when the bundle is missing", () => {
		const empty = mkdtempSync(join(tmpdir(), "dsh-prime-empty-"));
		expect(resolvePrimeCli(empty)).toBeUndefined();
		expect(resolveAcpChild(empty)).toBeUndefined();
	});

	it("resolveAcpChild uses process.execPath and --mode acp", () => {
		const { root, cli } = fakeCheckout();
		expect(resolveAcpChild(root)).toEqual({
			command: process.execPath,
			args: [cli, "--mode", "acp"],
		});
	});
});
