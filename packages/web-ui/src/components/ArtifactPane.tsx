import { useState } from "react";
import type { ArtifactStore, CardEvent, StepEvent, SubagentEvent } from "../lib/ws";
import { useQuantStore } from "../lib/store";
import { FilesView } from "./FilesView";
import { PipelineView } from "./PipelineView";
import { QuantCard } from "./QuantCard";
import { SubagentList } from "./SubagentList";
import { TearsheetView } from "./TearsheetView";

type ArtifactTab = "tearsheet" | "files" | "pipeline";

interface ArtifactPaneProps {
	readonly tearsheetUrl: string | null;
	readonly artifacts: ArtifactStore;
	readonly cards: Record<string, CardEvent>;
	readonly steps: Record<string, StepEvent>;
	readonly subagents: Record<string, SubagentEvent>;
}

const TAB_LABEL: Record<ArtifactTab, string> = {
	tearsheet: "Tearsheet",
	files: "Files",
	pipeline: "Pipeline",
};

export function ArtifactPane({ tearsheetUrl, artifacts, cards, steps, subagents }: ArtifactPaneProps) {
	const [tab, setTab] = useState<ArtifactTab>("tearsheet");
	const cardList = Object.values(cards);
	const agentCount = Object.keys(subagents).length;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Tab bar */}
			<header className="flex shrink-0 items-center border-b border-term-border">
				{(Object.keys(TAB_LABEL) as ArtifactTab[]).map((value) => (
					<button
						key={value}
						type="button"
						onClick={() => setTab(value)}
						className={`border-r border-term-border px-3 py-2 text-xs uppercase tracking-wider last:border-r-0 ${
							tab === value ? "bg-term-panel text-term-accent" : "text-term-dim hover:text-term-fg"
						}`}
					>
						{TAB_LABEL[value]}
					</button>
				))}
			</header>

			{/* Tab content */}
			<div className="flex min-h-0 flex-1 flex-col">
				{tab === "tearsheet" ? (
					<div className="flex min-h-0 flex-1 flex-col">
						{cardList.length > 0 ? (
							<div className="shrink-0 space-y-2 overflow-y-auto border-b border-term-border p-2">
								{cardList.map((card) => (
									<QuantCard key={card.id} card={card} />
								))}
							</div>
						) : null}
						<TearsheetView url={tearsheetUrl} />
					</div>
				) : null}
				{tab === "files" ? <FilesView artifacts={artifacts} /> : null}
				{tab === "pipeline" ? <PipelineView steps={steps} /> : null}
			</div>

			{/* Sub-agent monitor pinned at the bottom */}
			<section className="flex min-h-0 shrink-0 flex-col border-t border-term-border" style={{ maxHeight: "38%" }}>
				<header className="flex shrink-0 items-center justify-between border-b border-term-border px-3 py-2">
					<span className="text-xs uppercase tracking-wider text-term-dim">
						sub-agents <span className="text-term-fg">({agentCount})</span>
					</span>
					<span className="text-[10px] uppercase tracking-wider text-term-dim">worker tier</span>
				</header>
				<SubagentList subagents={subagents} />
			</section>
		</div>
	);
}

/** Convenience wrapper that reads the store and renders ArtifactPane. */
export function ArtifactPaneConnected() {
	const { tearsheetUrl, artifacts, cards, steps, subagents } = useQuantStore();
	return (
		<ArtifactPane
			tearsheetUrl={tearsheetUrl}
			artifacts={artifacts}
			cards={cards}
			steps={steps}
			subagents={subagents}
		/>
	);
}
