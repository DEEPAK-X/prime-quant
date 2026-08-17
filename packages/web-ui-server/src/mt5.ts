/**
 * Throttled read-only MetaTrader 5 health probe (docs/gui-wiring/03 §M4).
 *
 * Runs a short Python script through the kernel venv's interpreter — the same
 * venv the agent kernel uses, which has the MT5 IPC bridge installed. The
 * probe is read-only: it initializes the bridge, collects account/symbol
 * counts, shuts down, and never sends orders.
 *
 * Results are cached for 30 s with single-in-flight dedupe so concurrent
 * `/api/mt5` calls share one probe; a missing venv resolves to
 * `status: "unknown"` without spawning anything.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { Mt5Status } from "./events.js";

export const DEFAULT_MT5_CACHE_MS = 30_000;
export const DEFAULT_MT5_TIMEOUT_MS = 10_000;

/** Resolve the kernel venv python (Windows: Scripts/python.exe, else bin/python). */
export function defaultMt5Python(venvRoot: string = join(homedir(), ".prime", "agent", "kernel-venv")): string {
	return process.platform === "win32" ? join(venvRoot, "Scripts", "python.exe") : join(venvRoot, "bin", "python");
}

/**
 * Probe script: import the MT5 bridge (primequant or the kernel quant skill
 * bundle), initialize, collect a one-line JSON status, always shut down.
 * `-c` is used so no extra files are needed on the Windows box.
 */
const MT5_PROBE_SCRIPT = `
import json
import sys


def pick(obj, key):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


try:
    from primequant.data.mt5 import MT5Bridge
except Exception as first_error:
    try:
        from quant.data.mt5 import MT5Bridge
    except Exception as second_error:
        print(json.dumps({"status": "down", "reason": "MT5Bridge import failed: %s / %s" % (first_error, second_error)}))
        sys.exit(0)

bridge = None
try:
    bridge = MT5Bridge()
    if not bridge.initialize():
        print(json.dumps({"status": "down", "reason": "initialize() returned false"}))
        sys.exit(0)
    info = bridge.account_info()
    symbols = bridge.symbols_get()
    detail = {
        "server": pick(info, "server") or "",
        "login": pick(info, "login"),
        "symbols": len(symbols) if symbols is not None else 0,
    }
    print(json.dumps({"status": "ok", "detail": detail}))
except Exception as error:
    print(json.dumps({"status": "down", "reason": str(error)}))
finally:
    if bridge is not None:
        try:
            bridge.shutdown()
        except Exception:
            pass
`.trim();

export interface Mt5ProbeOptions {
	/** Absolute path to the venv python (tests). Defaults to the kernel venv. */
	pythonPath?: string;
	/** Override the venv root used to derive the python path. */
	venvRoot?: string;
	/** Inject spawn (tests use a fake child). */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Cache TTL, ms (default 30 000). */
	cacheMs?: number;
	/** Per-probe timeout, ms (default 10 000). */
	timeoutMs?: number;
	log?: (message: string) => void;
}

export interface Mt5Probe {
	/** Cached status; probes only when the cache is stale or empty. */
	getStatus(): Promise<Mt5Status>;
	/** Force a fresh probe outside the cache window. */
	refresh(): Promise<Mt5Status>;
	/** Last known status without probing (null before the first probe). */
	peek(): Mt5Status | null;
}

/** Parse the probe's single JSON line into a contract status, or null. */
export function parseProbeOutput(stdout: string): Mt5Status | null {
	const text = stdout.trim();
	if (!text) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	if (record.status === "ok") {
		const detail = (typeof record.detail === "object" && record.detail !== null ? record.detail : {}) as Record<
			string,
			unknown
		>;
		return {
			status: "ok",
			detail: {
				server: typeof detail.server === "string" ? detail.server : undefined,
				login: typeof detail.login === "number" ? detail.login : undefined,
				symbols: typeof detail.symbols === "number" ? detail.symbols : undefined,
			},
			checkedAt: new Date().toISOString(),
		};
	}
	if (record.status === "down" || record.status === "unknown") {
		return { status: record.status, detail: null, checkedAt: new Date().toISOString() };
	}
	return null;
}

export function createMt5Probe(options: Mt5ProbeOptions = {}): Mt5Probe {
	const cacheMs = options.cacheMs ?? DEFAULT_MT5_CACHE_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_MT5_TIMEOUT_MS;
	const spawnFn = options.spawn ?? nodeSpawn;
	const log = options.log ?? (() => {});
	const pythonPath = options.pythonPath ?? defaultMt5Python(options.venvRoot);

	let cached: Mt5Status | null = null;
	let cachedAt = 0;
	let inFlight: Promise<Mt5Status> | null = null;

	const probeOnce = (): Promise<Mt5Status> =>
		new Promise((resolve) => {
			const finish = (status: Mt5Status) => {
				cached = status;
				cachedAt = Date.now();
				resolve(status);
			};

			if (!existsSync(pythonPath)) {
				log(`[mt5] venv python not found at ${pythonPath}; status unknown`);
				finish({ status: "unknown", detail: null, checkedAt: new Date().toISOString() });
				return;
			}

			let child: ChildProcess;
			try {
				child = spawnFn(pythonPath, ["-c", MT5_PROBE_SCRIPT], {
					cwd: process.cwd(),
					env: process.env,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				} satisfies SpawnOptions);
			} catch (error) {
				log(`[mt5] spawn failed: ${String(error)}`);
				finish({ status: "down", detail: null, checkedAt: new Date().toISOString() });
				return;
			}

			const decoder = new StringDecoder("utf8");
			let stdout = "";
			let stderrTail = "";
			let settled = false;

			const settle = (status: Mt5Status) => {
				if (settled) {
					return;
				}
				settled = true;
				finish(status);
			};

			const timer = setTimeout(() => {
				log(`[mt5] probe timed out after ${timeoutMs}ms`);
				child.kill("SIGKILL");
				settle({ status: "down", detail: null, checkedAt: new Date().toISOString() });
			}, timeoutMs);

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += decoder.write(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				log(`[mt5] probe process error: ${error.message}`);
				settle({ status: "down", detail: null, checkedAt: new Date().toISOString() });
			});
			child.on("exit", () => {
				clearTimeout(timer);
				stdout += decoder.end();
				const parsed = parseProbeOutput(stdout);
				if (parsed) {
					settle(parsed);
					return;
				}
				const stderr = stderrTail ? ` stderr: ${stderrTail.slice(0, 200)}` : "";
				log(`[mt5] unparseable probe output: ${stdout.slice(0, 200)}${stderr}`);
				settle({ status: "down", detail: null, checkedAt: new Date().toISOString() });
			});
		});

	const runProbe = (): Promise<Mt5Status> => {
		if (inFlight) {
			return inFlight;
		}
		inFlight = probeOnce().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};

	return {
		async getStatus() {
			if (cached && Date.now() - cachedAt < cacheMs) {
				return cached;
			}
			return runProbe();
		},
		async refresh() {
			return runProbe();
		},
		peek() {
			return cached;
		},
	};
}
