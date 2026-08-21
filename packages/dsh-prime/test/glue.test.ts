import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mt5Probe, Mt5Status } from "@earendil-works/pi-web-ui-server";
import { describe, expect, it } from "vitest";
import type { HostContext } from "../src/dsh-types.js";
import {
	apply as applyGlueOnly,
	createPrimeGlue,
	PRIME_PROMPT_SECTION,
	PRIME_PROMPT_SECTION_ID,
	resolvePrimeReport,
} from "../src/host/glue.js";
import { apply as applyHost } from "../src/host/index.js";

function stubMt5(status: Mt5Status = { status: "unknown", detail: null, checkedAt: null }): Mt5Probe {
	return {
		getStatus: async () => status,
		refresh: async () => status,
		peek: () => status,
	};
}

describe("prime reports path guard", () => {
	it("rejects traversal, UNC, and absolute paths; serves a file inside the root", () => {
		const root = mkdtempSync(join(tmpdir(), "dsh-reports-"));
		writeFileSync(join(root, "tearsheet.html"), "<html></html>");

		const traversal = resolvePrimeReport(root, "../secret");
		expect(traversal.ok).toBe(false);
		if (!traversal.ok) {
			expect(traversal.reason).toBe("rejected");
		}
		expect(resolvePrimeReport(root, "..\\secret").ok).toBe(false);
		expect(resolvePrimeReport(root, "\\\\server\\share").ok).toBe(false);
		expect(resolvePrimeReport(root, join(root, "tearsheet.html")).ok).toBe(false);
		expect(resolvePrimeReport(root, "tearsheet.html")).toEqual({
			ok: true,
			path: join(root, "tearsheet.html"),
		});
		expect(resolvePrimeReport(root, "missing.html")).toEqual({ ok: false, reason: "missing" });
	});
});

describe("prime host glue", () => {
	it("registers the frozen prompt section and does not probe MT5 on apply", () => {
		const sections: Array<{ id: string; content: string }> = [];
		let probed = false;
		const mt5: Mt5Probe = {
			getStatus: async () => {
				probed = true;
				return { status: "unknown", detail: null, checkedAt: null };
			},
			refresh: async () => ({ status: "unknown", detail: null, checkedAt: null }),
			peek: () => null,
		};
		const glue = createPrimeGlue({
			cliPath: undefined,
			pool: undefined,
			artifactsRoot: mkdtempSync(join(tmpdir(), "dsh-glue-")),
			mt5,
		});
		const ctx: HostContext = {
			systemPrompt: {
				register(section) {
					sections.push(section);
				},
			},
		};
		glue.applyGlue(ctx);
		expect(sections).toEqual([{ id: PRIME_PROMPT_SECTION_ID, content: PRIME_PROMPT_SECTION }]);
		expect(glue.didProbe()).toBe(false);
		expect(probed).toBe(false);
		expect(PRIME_PROMPT_SECTION).toContain("subagent_prime");
		expect(PRIME_PROMPT_SECTION).toContain("rlm.quant");
	});

	it("host apply does not spawn and registers the prompt section", () => {
		const sections: Array<{ id: string; content: string }> = [];
		applyHost({
			systemPrompt: {
				register(section) {
					sections.push(section);
				},
			},
		});
		expect(sections[0]?.id).toBe(PRIME_PROMPT_SECTION_ID);
		applyGlueOnly({
			systemPrompt: {
				register(section) {
					sections.push(section);
				},
			},
		});
		expect(sections).toHaveLength(2);
	});

	it("GET /prime-status probes MT5 lazily", async () => {
		const root = mkdtempSync(join(tmpdir(), "dsh-status-"));
		mkdirSync(root, { recursive: true });
		const glue = createPrimeGlue({
			cliPath: "/repo/cli.js",
			pool: undefined,
			artifactsRoot: root,
			mt5: stubMt5({ status: "down", detail: null, checkedAt: "2026-08-22T00:00:00Z" }),
		});
		expect(glue.didProbe()).toBe(false);
		const status = await glue.getStatus();
		expect(glue.didProbe()).toBe(true);
		expect(status).toMatchObject({
			cliPath: "/repo/cli.js",
			pool: "stopped",
			mt5: { status: "down" },
		});
	});
});
