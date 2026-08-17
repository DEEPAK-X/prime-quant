import chalk from "chalk";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

interface StartupProgressState {
	timer: NodeJS.Timeout;
	frameIndex: number;
	currentMessage: string;
	startTime: number;
}

let activeState: StartupProgressState | undefined;
let cleanupRegistered = false;

export function hasNonInteractiveStartupFlag(argv: readonly string[]): boolean {
	for (const arg of argv) {
		if (
			arg === "--mode" ||
			arg === "daemon" ||
			arg === "rpc" ||
			arg === "acp" ||
			arg === "--json" ||
			arg === "-p" ||
			arg === "--print" ||
			arg === "-h" ||
			arg === "--help" ||
			arg === "-v" ||
			arg === "--version" ||
			arg === "--list-models" ||
			arg === "export"
		) {
			return true;
		}
	}
	return false;
}

export function shouldEnableStartupProgress(
	argv: readonly string[] = process.argv.slice(2),
	isStderrTty = process.stderr.isTTY,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!isStderrTty) {
		return false;
	}
	if (env.CI || env.NODE_ENV === "test" || env.PI_STARTUP_BENCHMARK) {
		return false;
	}
	if (env.PI_CODING_AGENT_DAEMON_WORKER || env.PI_DAEMON_CATALOG_PROCESS || env.PI_CODING_AGENT_OWNED_WORKER) {
		return false;
	}
	return !hasNonInteractiveStartupFlag(argv);
}

const PLAIN_TEXT_INTERVAL_MS = 10_000;

interface PlainTextProgressState {
	timer?: NodeJS.Timeout;
	currentMessage: string;
	startTime: number;
	lastLine: string;
}

let plainTextState: PlainTextProgressState | undefined;

/**
 * Some Windows terminal hosts (npm run under PowerShell) do not expose a TTY on
 * stderr, which silently disables the spinner and every startup error. Fall back
 * to plain text on stdout so a slow or failed daemon boot is always visible.
 */
export function shouldEmitPlainTextStartupProgress(
	argv: readonly string[] = process.argv.slice(2),
	isStderrTty = process.stderr.isTTY,
	env: NodeJS.ProcessEnv = process.env,
	stdoutIsTty = process.stdout.isTTY,
): boolean {
	if (isStderrTty || !stdoutIsTty) {
		return false;
	}
	if (env.CI || env.NODE_ENV === "test" || env.PI_STARTUP_BENCHMARK) {
		return false;
	}
	if (env.PI_CODING_AGENT_DAEMON_WORKER || env.PI_DAEMON_CATALOG_PROCESS || env.PI_CODING_AGENT_OWNED_WORKER) {
		return false;
	}
	return !hasNonInteractiveStartupFlag(argv);
}

function writePlainTextProgress(message: string, elapsedSec?: number): void {
	if (!plainTextState) {
		return;
	}
	const line = elapsedSec === undefined ? `Prime Agent: ${message}` : `Prime Agent: ${message} (${elapsedSec}s)`;
	if (plainTextState.lastLine === line) {
		return;
	}
	plainTextState.lastLine = line;
	process.stdout.write(`${line}\n`);
}

function startPlainTextProgress(initialMessage: string): void {
	if (plainTextState) {
		plainTextState.currentMessage = initialMessage;
		return;
	}
	plainTextState = {
		currentMessage: initialMessage,
		startTime: Date.now(),
		lastLine: "",
	};
	writePlainTextProgress(initialMessage);
	plainTextState.timer = setInterval(() => {
		if (!plainTextState) {
			return;
		}
		const elapsedSec = Math.round((Date.now() - plainTextState.startTime) / 1000);
		writePlainTextProgress(plainTextState.currentMessage, elapsedSec);
	}, PLAIN_TEXT_INTERVAL_MS);
	plainTextState.timer.unref();
}

function renderFrame(): void {
	if (!activeState) {
		return;
	}
	const frame = SPINNER_FRAMES[activeState.frameIndex];
	const elapsedSec = ((Date.now() - activeState.startTime) / 1000).toFixed(1);
	const elapsedText = Number(elapsedSec) >= 1.5 ? chalk.dim(` (${elapsedSec}s)`) : "";
	const line = `\r\x1b[2K${chalk.cyan(frame)} ${chalk.bold("Prime Agent")} ${chalk.dim("•")} ${activeState.currentMessage}${elapsedText}`;
	process.stderr.write(line);
	activeState.frameIndex = (activeState.frameIndex + 1) % SPINNER_FRAMES.length;
}

export function startStartupProgress(initialMessage = "Starting up...", argv?: readonly string[]): void {
	if (activeState) {
		activeState.currentMessage = initialMessage;
		return;
	}
	if (!shouldEnableStartupProgress(argv)) {
		if (shouldEmitPlainTextStartupProgress(argv)) {
			startPlainTextProgress(initialMessage);
		}
		return;
	}

	if (!cleanupRegistered) {
		cleanupRegistered = true;
		process.once("exit", () => stopStartupProgress());
	}

	activeState = {
		timer: setInterval(renderFrame, INTERVAL_MS),
		frameIndex: 0,
		currentMessage: initialMessage,
		startTime: Date.now(),
	};
	renderFrame();
}

export function updateStartupProgress(message: string): void {
	if (activeState) {
		activeState.currentMessage = message;
		renderFrame();
		return;
	}
	if (plainTextState) {
		plainTextState.currentMessage = message;
		writePlainTextProgress(message);
	}
}

export function stopStartupProgress(): void {
	if (activeState) {
		clearInterval(activeState.timer);
		activeState = undefined;
		if (process.stderr.isTTY) {
			process.stderr.write("\r\x1b[2K");
		}
	}
	if (plainTextState) {
		if (plainTextState.timer) {
			clearInterval(plainTextState.timer);
		}
		plainTextState = undefined;
	}
}
