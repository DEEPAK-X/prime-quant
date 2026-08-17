/**
 * Collapsible reasoning trace.
 *
 * Open while the thinking stream is live (done === false), auto-collapse when
 * done flips true. Header shows an elapsed-time label computed from startedAt,
 * ticking every 200ms while open. Body is monospace, dim, wrapped in a
 * bordered terminal panel.
 */
import { useEffect, useRef, useState } from "react";
import type { ThinkingBlock } from "../lib/ws";

interface ThinkingProps {
	readonly block: ThinkingBlock;
}

export function Thinking({ block }: ThinkingProps) {
	const [open, setOpen] = useState(!block.done);
	const [elapsed, setElapsed] = useState(0);

	// Auto-collapse when the stream finalizes.
	useEffect(() => {
		if (block.done) setOpen(false);
	}, [block.done]);

	// Tick elapsed time while the accordion is open and the stream is live.
	const rafRef = useRef<number | null>(null);
	useEffect(() => {
		if (!open || block.done) return;
		const tick = () => {
			setElapsed(Math.max(0, Date.now() - block.startedAt));
			rafRef.current = window.setTimeout(tick, 200) as unknown as number;
		};
		rafRef.current = window.setTimeout(tick, 200) as unknown as number;
		return () => {
			if (rafRef.current !== null) window.clearTimeout(rafRef.current);
		};
	}, [open, block.done, block.startedAt]);

	const seconds = (elapsed / 1000).toFixed(1);

	return (
		<div className="border border-term-border bg-term-bg">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-term-panel"
			>
				<span className="text-[10px] text-term-dim">{open ? "▾" : "▸"}</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">thinking</span>
				<span className="text-[10px] text-term-dim">
					{block.done ? "done" : `${seconds}s`}
				</span>
			</button>
			{open ? (
				<pre className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-term-border px-2 py-1 text-[11px] leading-relaxed text-term-dim">
					{block.text || "…"}
				</pre>
			) : null}
		</div>
	);
}
