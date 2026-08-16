/**
 * Task-based model tier routing for quant research.
 *
 * Maps three tiers of work to provider/model references:
 *   - orchestrator: the interactive chat / TUI loop model
 *   - reasoning:    heavy mathematical verification and AST leakage audits
 *   - worker:       high-throughput `rlm` subagent parameter sweeps
 *
 * Tiers are configured through the settings JSON (`modelTiers` in
 * `.prime/agent/settings.json`, project or global scope) and can be overridden
 * per environment with `PRIME_QUANT_TIER_<TIER>` env vars. The RLM subagent
 * loop routes `rlm.run(model="tier:<name>")` selectors to the configured
 * reference, and defaults spawned subagents to the worker tier when set.
 */

export const MODEL_TIERS = ["orchestrator", "reasoning", "worker"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_TIER_ENV_PREFIX = "PRIME_QUANT_TIER";

/** `provider/model` (or bare model pattern) reference per tier. */
export interface ModelTiersConfig {
	orchestrator?: string;
	reasoning?: string;
	worker?: string;
}

const TIER_SELECTOR_PREFIX = "tier:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelTier(value: unknown): value is ModelTier {
	return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/** Parse a `tier:<name>` rlm.run model selector. Returns undefined for non-selectors. */
export function parseTierSelector(reference: string): ModelTier | undefined {
	const trimmed = reference.trim();
	if (!trimmed.toLowerCase().startsWith(TIER_SELECTOR_PREFIX)) {
		return undefined;
	}
	const tier = trimmed.slice(TIER_SELECTOR_PREFIX.length).trim().toLowerCase();
	return isModelTier(tier) ? tier : undefined;
}

/**
 * Normalize a raw `modelTiers` settings value into a validated config.
 * Invalid tier names and non-string references are dropped.
 */
export function normalizeModelTiersConfig(value: unknown): ModelTiersConfig {
	if (!isRecord(value)) {
		return {};
	}
	const config: ModelTiersConfig = {};
	for (const tier of MODEL_TIERS) {
		const reference = value[tier];
		if (typeof reference === "string" && reference.trim()) {
			config[tier] = reference.trim();
		}
	}
	return config;
}

function envVarFor(tier: ModelTier): string {
	return `${MODEL_TIER_ENV_PREFIX}_${tier.toUpperCase()}`;
}

/**
 * Resolve the configured model reference for a tier.
 *
 * Precedence (highest first): env var `PRIME_QUANT_TIER_<TIER>`, then the
 * `modelTiers` settings config. Returns undefined when the tier is unset.
 */
export function resolveModelTierReference(tier: ModelTier, config: ModelTiersConfig): string | undefined {
	const envValue = process.env[envVarFor(tier)];
	if (typeof envValue === "string" && envValue.trim()) {
		return envValue.trim();
	}
	const configured = config[tier];
	return configured && configured.trim() ? configured : undefined;
}
