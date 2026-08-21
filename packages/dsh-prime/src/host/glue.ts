import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";

import { createMt5Probe, type Mt5Probe, type Mt5Status, resolveArtifactPath } from "@earendil-works/pi-web-ui-server";

import type {
	HostContext,
	PrimeHttpRequest,
	PrimeHttpResponse,
	PrimeStatusBody,
	PrimeStatusPool,
} from "../dsh-types.js";
import type { PrimeRpcPool } from "./pool.js";

export const PRIME_PROMPT_SECTION = [
	"Quant research (backtests, CPCV/walk-forward/DSR/PBO validation, MT5 market data,",
	"tearsheets, and rlm.quant.*) must be delegated to the subagent_prime tool.",
	"Do not reimplement those workflows in bash or by editing Python in this session.",
].join(" ");

export const PRIME_PROMPT_SECTION_ID = "prime-quant-delegate";

export interface PrimeGlueOptions {
	cliPath: string | undefined;
	pool: PrimeRpcPool | undefined;
	artifactsRoot: string;
	mt5?: Mt5Probe;
}

function mimeFor(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		default:
			return "application/octet-stream";
	}
}

/**
 * Resolve a `/prime-reports/<file>` URL to an allowlisted file, or a reject reason.
 * Traversal / absolute / UNC → "rejected". Missing → "missing".
 */
export function resolvePrimeReport(
	artifactsRoot: string,
	requested: string | undefined,
): { ok: true; path: string } | { ok: false; reason: "rejected" | "missing" } {
	if (!requested) return { ok: false, reason: "rejected" };
	const stripped = requested.replace(/^\/prime-reports\/?/, "");
	const resolved = resolveArtifactPath(artifactsRoot, stripped);
	if (!resolved) return { ok: false, reason: "rejected" };
	if (!existsSync(resolved)) return { ok: false, reason: "missing" };
	try {
		if (!statSync(resolved).isFile()) return { ok: false, reason: "missing" };
	} catch {
		return { ok: false, reason: "missing" };
	}
	return { ok: true, path: resolved };
}

function poolStatus(pool: PrimeRpcPool | undefined): PrimeStatusPool {
	if (!pool) return "stopped";
	const state = pool.getAgentState();
	if (state === "stopped") return "stopped";
	if (pool.isBusy() || state === "busy" || state === "starting") return "busy";
	return "idle";
}

export function createPrimeGlue(options: PrimeGlueOptions) {
	const probe = options.mt5 ?? createMt5Probe();
	let probed = false;

	async function getMt5(): Promise<Mt5Status> {
		probed = true;
		return probe.getStatus();
	}

	async function getStatus(): Promise<PrimeStatusBody> {
		const mt5 = await getMt5();
		return {
			mt5,
			cliPath: options.cliPath ?? null,
			pool: poolStatus(options.pool),
		};
	}

	function didProbe(): boolean {
		return probed;
	}

	async function handleReport(req: PrimeHttpRequest, res: PrimeHttpResponse): Promise<void> {
		const url = req.url ?? "";
		const pathPart = url.split("?")[0] ?? "";
		const requested = pathPart.replace(/^\/prime-reports\/?/, "");
		const resolved = resolvePrimeReport(options.artifactsRoot, requested);
		if (!resolved.ok && resolved.reason === "rejected") {
			res.status(400).json({ error: "path is outside the allowlisted artifacts root" });
			return;
		}
		if (!resolved.ok) {
			res.status(404).json({ error: "artifact not found" });
			return;
		}
		res.status(200).type(mimeFor(resolved.path)).json({ file: resolved.path });
	}

	function applyGlue(ctx: HostContext): void {
		ctx.systemPrompt?.register({ id: PRIME_PROMPT_SECTION_ID, content: PRIME_PROMPT_SECTION });
		ctx.webServer?.get("/prime-reports", (req, res) => handleReport(req, res));
		ctx.webServer?.get("/prime-reports/*", (req, res) => handleReport(req, res));
		ctx.webServer?.get("/prime-status", async (_req, res) => {
			const body = await getStatus();
			res.status(200).json(body);
		});
	}

	return {
		applyGlue,
		getStatus,
		getMt5,
		didProbe,
		resolvePrimeReport: resolvePrimeReport.bind(null, options.artifactsRoot),
	};
}

export function apply(ctx: HostContext = {}): void {
	// Standalone glue entry (`@prime-quant/dsh-prime/host-glue`). The composed
	// host apply() in index.ts wires pool + cliPath; this export registers the
	// prompt section only so DSH can mount the row without spawning Prime.
	ctx.systemPrompt?.register({ id: PRIME_PROMPT_SECTION_ID, content: PRIME_PROMPT_SECTION });
}
