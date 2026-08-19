import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStatus } from "../../core/auth-storage.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../../core/prime-inference-auth.js";

export interface OnboardingSettingsReader {
	getOnboardingShown(): boolean;
}

export interface OnboardingModelRegistryReader {
	refresh(): void;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): AuthStatus;
}

export interface OnboardingStartupState {
	settingsManager: OnboardingSettingsReader;
	modelRegistry: OnboardingModelRegistryReader;
	model: Model<Api> | undefined;
}

export function shouldRunPrimeCliOnboardingSplash(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown()) {
		return false;
	}
	if (!state.model || state.model.provider !== PRIME_INFERENCE_PROVIDER_ID) {
		return false;
	}
	const authStatus = state.modelRegistry.getProviderAuthStatus(PRIME_INFERENCE_PROVIDER_ID);
	return authStatus.source === "prime_cli";
}

export function isOnboardingModelReady(state: OnboardingStartupState): boolean {
	return state.model !== undefined && state.modelRegistry.hasConfiguredAuth(state.model);
}

export function hasEnvApiKeys(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(
		env.ANTHROPIC_API_KEY ||
			env.OPENAI_API_KEY ||
			env.GEMINI_API_KEY ||
			env.GROQ_API_KEY ||
			env.DEEPSEEK_API_KEY ||
			env.MISTRAL_API_KEY ||
			env.TOGETHER_API_KEY ||
			env.FIREWORKS_API_KEY ||
			env.PRIME_API_KEY ||
			env.PRIME_AGENT_LIGHTWEIGHT === "1" ||
			env.PRIME_AGENT_LIGHTWEIGHT === "true",
	);
}

export function shouldRunOnboarding(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown() || hasEnvApiKeys()) {
		return false;
	}
	state.modelRegistry.refresh();
	if (shouldRunPrimeCliOnboardingSplash(state)) {
		return true;
	}
	return !isOnboardingModelReady(state);
}
