/**
 * Prime Agent settings card body for DSH's configurable-plugins tab.
 *
 * Reads A's host-glue `GET /prime-status` (same origin, no daemon call, no
 * Prime spawn). Display-only: A exposes no POST reprobe in v1, so the pill
 * never triggers a probe — Refresh only re-reads the cached status.
 */

import { useCallback, useEffect, useState } from "react";

const COLOR_BORDER = "#30363d";
const COLOR_FG = "#e6edf3";
const COLOR_DIM = "#8b949e";
const COLOR_BG = "#0d1117";
const COLOR_PASS = "#3fb950";
const COLOR_FAIL = "#f85149";
const COLOR_UNKNOWN = "#8b949e";
const COLOR_BUSY = "#d29922";

export type Mt5Health = "ok" | "down" | "unknown";
export type PoolStatus = "idle" | "busy" | "stopped";

/** Mirrors PrimeStatusBody served by packages/dsh-prime/src/host/glue.ts. */
export interface PrimeStatusBody {
	readonly mt5: {
		readonly status: Mt5Health;
		readonly detail: { readonly server?: string; readonly login?: number; readonly symbols?: number } | null;
		readonly checkedAt: string | null;
	};
	readonly cliPath: string | null;
	readonly pool: PoolStatus;
}

const CLI_PATH_PLACEHOLDER = "resolved at runtime by host glue";
const TOOL_COPY =
	"Quant backtests and validation run in Prime Agent via subagent_prime. Enable the tool in Plugins if it is disabled.";

function mt5Color(status: Mt5Health): string {
	if (status === "ok") return COLOR_PASS;
	if (status === "down") return COLOR_FAIL;
	return COLOR_UNKNOWN;
}

function poolColor(status: PoolStatus): string {
	if (status === "busy") return COLOR_BUSY;
	if (status === "stopped") return COLOR_FAIL;
	return COLOR_PASS;
}

async function fetchStatus(): Promise<PrimeStatusBody> {
	const response = await fetch("/prime-status", { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`GET /prime-status returned ${response.status}`);
	}
	return (await response.json()) as PrimeStatusBody;
}

export function SettingsView() {
	const [status, setStatus] = useState<PrimeStatusBody | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	const refresh = useCallback(() => {
		fetchStatus().then(
			(body) => {
				setStatus(body);
				setError(undefined);
			},
			(cause: unknown) => {
				setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
	}, []);

	useEffect(refresh, [refresh]);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: COLOR_FG }}>
			<strong style={{ fontSize: 13 }}>Prime Agent</strong>

			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ minWidth: 64, color: COLOR_DIM }}>cli path</span>
				<code
					title={status?.cliPath ?? undefined}
					style={{
						minWidth: 0,
						flex: 1,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						border: `1px solid ${COLOR_BORDER}`,
						padding: "2px 6px",
						fontSize: 11,
						color: status?.cliPath ? COLOR_FG : COLOR_DIM,
						background: COLOR_BG,
					}}
				>
					{status?.cliPath ?? CLI_PATH_PLACEHOLDER}
				</code>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ minWidth: 64, color: COLOR_DIM }}>MT5</span>
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
						border: `1px solid ${COLOR_BORDER}`,
						padding: "1px 8px",
						color: mt5Color(status?.mt5.status ?? "unknown"),
					}}
				>
					{status?.mt5.status ?? "unknown"}
					{status?.mt5.detail?.server !== undefined ? <span style={{ color: COLOR_DIM }}>{status.mt5.detail.server}</span> : null}
				</span>
				<button
					type="button"
					onClick={refresh}
					style={{ background: "transparent", border: `1px solid ${COLOR_BORDER}`, padding: "1px 8px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_DIM, cursor: "pointer" }}
				>
					refresh
				</button>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ minWidth: 64, color: COLOR_DIM }}>pool</span>
				<span style={{ border: `1px solid ${COLOR_BORDER}`, padding: "1px 8px", color: poolColor(status?.pool ?? "stopped") }}>
					{status?.pool ?? "stopped"}
				</span>
			</div>

			<p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: COLOR_DIM }}>{TOOL_COPY}</p>
			{error !== undefined ? <p style={{ margin: 0, fontSize: 11, color: COLOR_FAIL }}>{error}</p> : null}
		</div>
	);
}
