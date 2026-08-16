import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	MODEL_TIER_ENV_PREFIX,
	normalizeModelTiersConfig,
	parseTierSelector,
	resolveModelTierReference,
} from "../src/core/model-tiers.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const ENV_KEYS = MODEL_TIERS_ENV_KEYS();

function MODEL_TIERS_ENV_KEYS(): string[] {
	return ["orchestrator", "reasoning", "worker"].map((tier) => `${MODEL_TIER_ENV_PREFIX}_${tier.toUpperCase()}`);
}

describe("parseTierSelector", () => {
	test("accepts tier:worker", () => {
		expect(parseTierSelector("tier:worker")).toBe("worker");
	});

	test("accepts tier:reasoning and tier:orchestrator", () => {
		expect(parseTierSelector("tier:reasoning")).toBe("reasoning");
		expect(parseTierSelector("tier:orchestrator")).toBe("orchestrator");
	});

	test("is case-insensitive", () => {
		expect(parseTierSelector("tier:WORKER")).toBe("worker");
	});

	test("rejects unknown tiers", () => {
		expect(parseTierSelector("tier:analyst")).toBeUndefined();
	});

	test("rejects non-selectors", () => {
		expect(parseTierSelector("anthropic/claude-opus-4-7")).toBeUndefined();
		expect(parseTierSelector("tier")).toBeUndefined();
		expect(parseTierSelector("")).toBeUndefined();
	});
});

describe("normalizeModelTiersConfig", () => {
	test("drops invalid entries", () => {
		const config = normalizeModelTiersConfig({
			orchestrator: "anthropic/claude-opus-4-7",
			reasoning: 42,
			worker: "  ",
			analyst: "openai/gpt-5.4",
		});
		expect(config).toEqual({ orchestrator: "anthropic/claude-opus-4-7" });
	});

	test("returns empty config for non-objects", () => {
		expect(normalizeModelTiersConfig(undefined)).toEqual({});
		expect(normalizeModelTiersConfig("tier:worker")).toEqual({});
	});
});

describe("resolveModelTierReference", () => {
	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = originalEnv[key];
			}
		}
	});

	test("uses the config reference when no env var is set", () => {
		const config = { worker: "openrouter/moonshotai/kimi-k2.6" };
		expect(resolveModelTierReference("worker", config)).toBe("openrouter/moonshotai/kimi-k2.6");
	});

	test("env var overrides config", () => {
		process.env.PRIME_QUANT_TIER_WORKER = "groq/openai/gpt-oss-120b";
		const config = { worker: "openrouter/moonshotai/kimi-k2.6" };
		expect(resolveModelTierReference("worker", config)).toBe("groq/openai/gpt-oss-120b");
	});

	test("returns undefined when unset", () => {
		expect(resolveModelTierReference("reasoning", {})).toBeUndefined();
	});
});

describe("SettingsManager modelTiers", () => {
	test("exposes normalized modelTiers from settings", () => {
		const manager = SettingsManager.inMemory({
			modelTiers: {
				orchestrator: "anthropic/claude-opus-4-7",
				reasoning: "openai/gpt-5.4",
				worker: "openrouter/moonshotai/kimi-k2.6",
			},
		});
		expect(manager.getModelTiers()).toEqual({
			orchestrator: "anthropic/claude-opus-4-7",
			reasoning: "openai/gpt-5.4",
			worker: "openrouter/moonshotai/kimi-k2.6",
		});
	});

	test("returns empty config when unset", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getModelTiers()).toEqual({});
	});

	test("ignores invalid tier entries", () => {
		const manager = SettingsManager.inMemory({
			modelTiers: { worker: 7 } as unknown as { worker: string },
		});
		expect(manager.getModelTiers()).toEqual({});
	});
});
