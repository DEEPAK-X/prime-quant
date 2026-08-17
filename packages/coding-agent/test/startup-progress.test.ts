import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	shouldEmitPlainTextStartupProgress,
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

	describe("shouldEmitPlainTextStartupProgress", () => {
		it("enables when stderr is not a TTY but stdout is", () => {
			expect(shouldEmitPlainTextStartupProgress([], false, {}, true)).toBe(true);
		});

		it("disables when stderr is a TTY", () => {
			expect(shouldEmitPlainTextStartupProgress([], true, {}, true)).toBe(false);
		});

		it("disables when stdout is not a TTY", () => {
			expect(shouldEmitPlainTextStartupProgress([], false, {}, false)).toBe(false);
		});

		it("disables in CI and test environments", () => {
			expect(shouldEmitPlainTextStartupProgress([], false, { CI: "true" }, true)).toBe(false);
			expect(shouldEmitPlainTextStartupProgress([], false, { NODE_ENV: "test" }, true)).toBe(false);
		});

		it("disables for daemon worker and catalog processes", () => {
			expect(shouldEmitPlainTextStartupProgress([], false, { PI_CODING_AGENT_DAEMON_WORKER: "1" }, true)).toBe(
				false,
			);
			expect(shouldEmitPlainTextStartupProgress([], false, { PI_DAEMON_CATALOG_PROCESS: "1" }, true)).toBe(false);
			expect(shouldEmitPlainTextStartupProgress([], false, { PI_CODING_AGENT_OWNED_WORKER: "1" }, true)).toBe(false);
		});

		it("disables for non-interactive CLI flags", () => {
			expect(shouldEmitPlainTextStartupProgress(["--mode", "json"], false, {}, true)).toBe(false);
			expect(shouldEmitPlainTextStartupProgress(["-p", "hello"], false, {}, true)).toBe(false);
			expect(shouldEmitPlainTextStartupProgress(["--version"], false, {}, true)).toBe(false);
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

		it("emits plain text progress on stdout when stderr is not a TTY", () => {
			const writes: string[] = [];
			const originalWrite = process.stdout.write.bind(process.stdout);
			const originalStdoutIsTty = process.stdout.isTTY;
			const originalStderrIsTty = process.stderr.isTTY;
			const originalNodeEnv = process.env.NODE_ENV;
			const originalCi = process.env.CI;
			process.stdout.write = ((chunk: string | Uint8Array) => {
				writes.push(String(chunk));
				return true;
			}) as unknown as typeof process.stdout.write;
			process.stdout.isTTY = true;
			process.stderr.isTTY = false;
			delete process.env.NODE_ENV;
			delete process.env.CI;
			try {
				startStartupProgress("Booting up...", ["--verbose"]);
				updateStartupProgress("Waiting for daemon readiness...");
				const output = writes.join("");
				expect(output).toContain("Prime Agent: Booting up...");
				expect(output).toContain("Prime Agent: Waiting for daemon readiness...");
				expect(output).not.toContain("\x1b[");
			} finally {
				stopStartupProgress();
				process.stdout.write = originalWrite;
				process.stdout.isTTY = originalStdoutIsTty;
				process.stderr.isTTY = originalStderrIsTty;
				if (originalNodeEnv === undefined) {
					delete process.env.NODE_ENV;
				} else {
					process.env.NODE_ENV = originalNodeEnv;
				}
				if (originalCi === undefined) {
					delete process.env.CI;
				} else {
					process.env.CI = originalCi;
				}
			}
		});
	});
});
