/**
 * Embedded tearsheet viewer.
 *
 * Renders the strategy report HTML in a sandboxed iframe (allow-same-origin so
 * local reports can load, no allow-scripts to keep injected content inert),
 * with a reload button and an open-in-browser link. A rotating key forces the
 * iframe to remount on reload (the srcdoc/src cache otherwise wins).
 */
import { useState } from "react";

interface TearsheetViewProps {
	readonly url: string | null;
}

export function TearsheetView({ url }: TearsheetViewProps) {
	const [reloadKey, setReloadKey] = useState(0);

	if (!url) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center">
				<p className="max-w-xs px-6 text-center text-[11px] leading-relaxed text-term-dim">
					no tearsheet yet — run the pipeline and the equity curves / drawdown heatmap / DSR card render here
				</p>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between border-b border-term-border px-2 py-1">
				<span className="min-w-0 flex-1 truncate text-[10px] text-term-dim">{url}</span>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onClick={() => setReloadKey((key) => key + 1)}
						className="text-[10px] uppercase tracking-wider text-term-accent hover:underline"
					>
						reload
					</button>
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-[10px] uppercase tracking-wider text-term-accent hover:underline"
					>
						open ↗
					</a>
				</div>
			</div>
			<iframe
				key={reloadKey}
				src={url}
				sandbox="allow-same-origin"
				className="min-h-0 flex-1 border-0 bg-term-bg"
				title="quant tearsheet"
			/>
		</div>
	);
}
