import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	shouldEnableStartupProgress,
	startStartupProgress,
	stopStartupProgress,
	updateStartupProgress,
} from "../src/cli/startup-progress.js";

describe("startup progress indicator", () => {
	beforeEach(() => {
		stopStartupProgress();
	});

	afterEach(() => {
		stopStartupProgress();
	});

	describe("shouldEnableStartupProgress", () => {
		it("disables when stderr is not a TTY", () => {
			expect(shouldEnableStartupProgress([], false, {})).toBe(false);
		});

		it("disables in CI environments", () => {
			expect(shouldEnableStartupProgress([], true, { CI: "true" })).toBe(false);
		});

		it("disables in test environments", () => {
			expect(shouldEnableStartupProgress([], true, { NODE_ENV: "test" })).toBe(false);
		});

		it("disables for benchmark runs", () => {
			expect(shouldEnableStartupProgress([], true, { PI_STARTUP_BENCHMARK: "1" })).toBe(false);
		});

		it("disables for daemon worker and catalog processes", () => {
			expect(shouldEnableStartupProgress([], true, { PI_CODING_AGENT_DAEMON_WORKER: "1" })).toBe(false);
			expect(shouldEnableStartupProgress([], true, { PI_DAEMON_CATALOG_PROCESS: "1" })).toBe(false);
			expect(shouldEnableStartupProgress([], true, { PI_CODING_AGENT_OWNED_WORKER: "1" })).toBe(false);
		});

		it("disables for non-interactive CLI flags", () => {
			expect(shouldEnableStartupProgress(["--mode", "json"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["daemon"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["rpc"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["acp"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["--json"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["-p", "hello"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["--print"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["--help"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["-h"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["--version"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["--list-models"], true, {})).toBe(false);
			expect(shouldEnableStartupProgress(["export", "test.jsonl"], true, {})).toBe(false);
		});

		it("enables for clean interactive startup", () => {
			expect(shouldEnableStartupProgress([], true, {})).toBe(true);
			expect(shouldEnableStartupProgress(["--verbose"], true, {})).toBe(true);
		});
	});

	describe("lifecycle", () => {
		it("safely starts, updates, and stops without errors", () => {
			expect(() => {
				startStartupProgress("Testing startup...", ["--verbose"]);
				updateStartupProgress("Connecting...");
				stopStartupProgress();
			}).not.toThrow();
		});

		it("handles multiple stop calls idempotently", () => {
			expect(() => {
				stopStartupProgress();
				stopStartupProgress();
			}).not.toThrow();
		});
	});
});
