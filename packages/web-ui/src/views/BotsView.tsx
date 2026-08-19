/**
 * Trading Bots view: pipeline steps, tearsheet library, and artifacts — the
 * content that used to live in the global artifact pane, now a first-class
 * view of its own.
 */
import { FilesView } from "../components/FilesView";
import { PipelineView } from "../components/PipelineView";
import { TearsheetView } from "../components/TearsheetView";
import { useQuantStore } from "../lib/store";

export function BotsView() {
	const { steps, tearsheetUrl, tearsheets, artifacts } = useQuantStore();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center justify-between border-b border-term-border px-4 py-2">
				<span className="text-xs uppercase tracking-widest text-term-dim">trading bots // pipeline output</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">
					{tearsheets.length} tearsheet{tearsheets.length === 1 ? "" : "s"}
				</span>
			</header>
			<div className="pq-view-in flex min-h-0 flex-1">
				<section className="flex min-w-0 flex-1 flex-col border-r border-term-border">
					<div className="flex min-h-0 flex-1 flex-col">
						<header className="shrink-0 border-b border-term-border px-3 py-1.5 text-[9px] uppercase tracking-widest text-term-dim">
							tearsheet
						</header>
						<TearsheetView url={tearsheetUrl} />
					</div>
					<div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-term-border">
						<header className="shrink-0 border-b border-term-border px-3 py-1.5 text-[9px] uppercase tracking-widest text-term-dim">
							pipeline
						</header>
						<PipelineView steps={steps} />
					</div>
				</section>
				<section className="flex w-[320px] min-w-[260px] shrink-0 flex-col">
					<header className="shrink-0 border-b border-term-border px-3 py-1.5 text-[9px] uppercase tracking-widest text-term-dim">
						artifacts
					</header>
					<FilesView artifacts={artifacts} />
					{tearsheets.length > 0 ? (
						<>
							<header className="shrink-0 border-y border-term-border px-3 py-1.5 text-[9px] uppercase tracking-widest text-term-dim">
								report history
							</header>
							<div className="min-h-0 overflow-y-auto">
								{tearsheets.map((sheet) => (
									<a
										key={sheet.url}
										href={sheet.url}
										target="_blank"
										rel="noreferrer"
										className="block truncate border-b border-term-border px-3 py-1.5 text-[10px] text-term-fg hover:bg-term-raised"
										title={sheet.ts ?? sheet.url}
									>
										{sheet.name ?? sheet.url}
									</a>
								))}
							</div>
						</>
					) : null}
				</section>
			</div>
		</div>
	);
}
