/**
 * Resilience surfaces (B4): fatal error banner + transient error toasts +
 * reconnect toast.
 *
 - `error` events with `fatal: true` render as a persistent red banner pinned
 -   under the topbar until dismissed; the store retains the last MAX_ERRORS so
 -   the banner reflects the most recent fatal one.
 - Non-fatal `error` events render as transient bottom-right toasts that
 -   auto-dismiss after a few seconds (each dismissible).
 - A reconnect toast surfaces when the WebSocket drops (connection !== "open"
 -   after the GUI has seen an open socket) so a transient backend blip is
 -   visible without a full-screen takeover.
 *
 All toasts use role="status" (non-fatal/reconnect) or role="alert" (fatal) so
 screen readers announce them appropriately.
 */
import { useEffect, useState } from "react";
import type { ConnectionState, QuantError } from "../lib/ws";

const NON_FATAL_TTL_MS = 6000;

/** Stable key for an error (the contract carries no id, so compose one). */
function keyOf(error: QuantError): string {
	return `${error.ts}|${error.scope}|${error.message}`;
}

function scopeLabel(scope: QuantError["scope"]): string {
	return scope;
}

interface StatusToastsProps {
	readonly errors: QuantError[];
	readonly connection: ConnectionState;
}

export function StatusToasts({ errors, connection }: StatusToastsProps) {
	const [dismissed, setDismissed] = useState<Set<string>>(new Set());
	const [autoHidden, setAutoHidden] = useState<Set<string>>(new Set());
	const [seenOpen, setSeenOpen] = useState(false);

	// Track whether we've ever observed an open socket so the reconnect toast
	// only appears after an actual drop, not on first connect.
	useEffect(() => {
		if (connection === "open") setSeenOpen(true);
	}, [connection]);

	// Reset dismissals when the error list is replaced (e.g. on reconnect a
	// fresh batch could arrive) — keep it simple: cleared ids are just hidden.
	const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));

	const visible = errors.filter((error) => {
		const key = keyOf(error);
		return !dismissed.has(key) && !autoHidden.has(key);
	});
	const fatal = visible.filter((error) => error.fatal);
	const nonFatal = visible.filter((error) => !error.fatal);

	// Auto-dismiss non-fatal toasts after TTL.
	useEffect(() => {
		if (nonFatal.length === 0) return;
		const timers = nonFatal.map((error) =>
			window.setTimeout(() => setAutoHidden((prev) => new Set(prev).add(keyOf(error))), NON_FATAL_TTL_MS),
		);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [nonFatal]);

	const latestFatal = fatal[fatal.length - 1] ?? null;
	const showReconnect = seenOpen && connection !== "open";

	return (
		<>
			{latestFatal ? (
				<div
					role="alert"
					className="flex shrink-0 items-start gap-2 border-b border-term-red bg-term-bg px-3 py-1.5"
				>
					<span className="mt-px text-[10px] uppercase tracking-wider text-term-red">fatal</span>
					<span className="text-[10px] uppercase tracking-wider text-term-dim">{scopeLabel(latestFatal.scope)}</span>
					<span className="min-w-0 flex-1 text-xs text-term-fg">{latestFatal.message}</span>
					<button
						type="button"
						onClick={() => dismiss(keyOf(latestFatal))}
						aria-label="Dismiss fatal error banner"
						className="shrink-0 text-[10px] uppercase tracking-wider text-term-dim hover:text-term-fg"
					>
						dismiss
					</button>
				</div>
			) : null}

			{nonFatal.length > 0 || showReconnect ? (
				<div className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-72 flex-col gap-1.5">
					{showReconnect ? (
						<Toast role="status" tone="yellow" title="reconnecting" body="backend disconnected — retrying with backoff" />
					) : null}
					{nonFatal.map((error) => (
						<div
							key={keyOf(error)}
							role="status"
							className="pointer-events-auto flex items-start gap-2 border border-term-border bg-term-panel px-2.5 py-1.5"
							style={{ borderRadius: "var(--radius-term-card)" }}
						>
							<span className="mt-px shrink-0 text-[10px] uppercase tracking-wider text-term-yellow">
								{scopeLabel(error.scope)}
							</span>
							<span className="min-w-0 flex-1 text-[11px] leading-snug text-term-fg">{error.message}</span>
							<button
								type="button"
								onClick={() => dismiss(keyOf(error))}
								aria-label="Dismiss error toast"
								className="shrink-0 text-[10px] uppercase tracking-wider text-term-dim hover:text-term-fg"
							>
								x
							</button>
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

function Toast({ role, tone, title, body }: { role: "status"; tone: "yellow" | "red"; title: string; body: string }) {
	const color = tone === "yellow" ? "text-term-yellow" : "text-term-red";
	return (
		<div
			role={role}
			className="pointer-events-auto flex items-start gap-2 border border-term-border bg-term-panel px-2.5 py-1.5"
			style={{ borderRadius: "var(--radius-term-card)" }}
		>
			<span className={`mt-px shrink-0 text-[10px] uppercase tracking-wider ${color}`}>{title}</span>
			<span className="min-w-0 flex-1 text-[11px] leading-snug text-term-fg">{body}</span>
		</div>
	);
}
