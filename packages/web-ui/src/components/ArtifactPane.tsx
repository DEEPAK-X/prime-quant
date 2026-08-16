import { useMemo, useState } from "react";
import type { ArtifactStore, SubagentEvent, SubagentStatus } from "../lib/ws";
import { useQuantStore } from "../lib/store";

const STATUS_BADGE: Record<SubagentStatus, string> = {
	RUNNING: "border-term-yellow text-term-yellow",
	DONE: "border-term-green text-term-green",
	ERROR: "border-term-red text-term-red",
};

const STATUS_DOT: Record<SubagentStatus, string> = {
	RUNNING: "animate-pulse bg-term-yellow",
	DONE: "bg-term-green",
	ERROR: "bg-term-red",
};

type ExportTab = "py" | "mq5";

interface ArtifactPaneProps {
	subagents: Record<string, SubagentEvent>;
	tearsheetUrl: string | null;
	artifacts: ArtifactStore;
}

function formatTpm(tokensPerMin?: number): string {
	if (tokensPerMin === undefined) return "";
	return `${(tokensPerMin / 1000).toFixed(1)}k tpm`;
}

export function ArtifactPane({ subagents, tearsheetUrl, artifacts }: ArtifactPaneProps) {
	const [tab, setTab] = useState<ExportTab>("py");
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	const agents = useMemo(() => {
		const rank: Record<SubagentStatus, number> = { RUNNING: 0, DONE: 1, ERROR: 2 };
		return Object.values(subagents).sort(
			(a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
		);
	}, [subagents]);

	const files = artifacts[tab];
	const selected = files.find((file) => file.name === selectedName) ?? files[files.length - 1] ?? null;

	const copy = (key: string, text: string) => {
		if (!navigator.clipboard) return;
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(key);
			window.setTimeout(() => setCopied(null), 1200);
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Sub-agent tree */}
			<section className="flex min-h-0 flex-[1.1] flex-col border-b border-term-border">
				<header className="flex items-center justify-between border-b border-term-border px-3 py-2">
					<span className="text-xs uppercase tracking-wider text-term-dim">
						sub-agents <span className="text-term-fg">({agents.length})</span>
					</span>
					<span className="text-[10px] uppercase tracking-wider text-term-dim">worker tier</span>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{agents.length === 0 ? (
						<p className="px-3 py-2 text-[11px] text-term-dim">no workers active</p>
					) : (
						agents.map((agent) => (
							<div key={agent.id} className="flex items-center gap-2 border-b border-term-border px-3 py-2">
								<span className={`h-1.5 w-1.5 shrink-0 ${STATUS_DOT[agent.status]}`} />
								<span className="min-w-0 flex-1 truncate text-xs text-term-fg">{agent.name}</span>
								{agent.task ? (
									<span className="hidden min-w-0 max-w-[40%] truncate text-[10px] text-term-dim" title={agent.task}>
										{agent.task}
									</span>
								) : null}
								{formatTpm(agent.tokensPerMin) ? (
									<span className="shrink-0 text-[10px] text-term-dim">{formatTpm(agent.tokensPerMin)}</span>
								) : null}
								<span className={`shrink-0 border px-1.5 py-0.5 text-[10px] ${STATUS_BADGE[agent.status]}`}>
									{agent.status}
								</span>
							</div>
						))
					)}
				</div>
			</section>

			{/* Visual artifact viewer */}
			<section className="flex min-h-0 flex-[1.4] flex-col border-b border-term-border">
				<header className="flex items-center justify-between border-b border-term-border px-3 py-2">
					<span className="text-xs uppercase tracking-wider text-term-dim">artifact // tearsheet</span>
					{tearsheetUrl ? (
						<span className="truncate text-[10px] text-term-dim">{tearsheetUrl}</span>
					) : null}
				</header>
				{tearsheetUrl ? (
					<iframe src={tearsheetUrl} className="h-full w-full border-0 bg-term-bg" title="quant tearsheet" />
				) : (
					<div className="flex min-h-0 flex-1 items-center justify-center">
						<p className="px-6 text-center text-[11px] leading-relaxed text-term-dim">
							no tearsheet yet — run the pipeline and the equity curves / drawdown heatmap / DSR card render here
						</p>
					</div>
				)}
			</section>

			{/* Export drawer */}
			<section className="flex min-h-0 flex-[1] flex-col">
				<header className="flex items-center border-b border-term-border">
					<button
						type="button"
						onClick={() => {
							setTab("py");
							setSelectedName(null);
						}}
						className={`border-r border-term-border px-3 py-2 text-xs uppercase tracking-wider ${
							tab === "py" ? "bg-term-panel text-term-accent" : "text-term-dim hover:text-term-fg"
						}`}
					>
						.py <span className="text-term-dim">({artifacts.py.length})</span>
					</button>
					<button
						type="button"
						onClick={() => {
							setTab("mq5");
							setSelectedName(null);
						}}
						className={`px-3 py-2 text-xs uppercase tracking-wider ${
							tab === "mq5" ? "bg-term-panel text-term-accent" : "text-term-dim hover:text-term-fg"
						}`}
					>
						.mq5 <span className="text-term-dim">({artifacts.mq5.length})</span>
					</button>
					<span className="ml-auto pr-3 text-[10px] uppercase tracking-wider text-term-dim">export</span>
				</header>
				{files.length === 0 ? (
					<p className="px-3 py-2 text-[11px] text-term-dim">no {tab} artifacts generated yet</p>
				) : (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="max-h-[38%] min-h-0 overflow-y-auto border-b border-term-border">
							{files.map((file) => (
								<button
									key={file.name}
									type="button"
									onClick={() => setSelectedName(file.name)}
									className={`flex w-full items-center gap-2 border-b border-term-border px-3 py-1.5 text-left text-xs hover:bg-term-panel ${
										selected?.name === file.name ? "bg-term-panel text-term-accent" : "text-term-fg"
									}`}
								>
									<span className="min-w-0 flex-1 truncate">{file.name}</span>
									<span className="shrink-0 text-[10px] text-term-dim">{file.content.length} chars</span>
								</button>
							))}
						</div>
						{selected ? (
							<div className="flex min-h-0 flex-1 flex-col">
								<div className="flex items-center justify-between border-b border-term-border px-3 py-1.5">
									<span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wider text-term-dim">
										{selected.name}
									</span>
									<button
										type="button"
										onClick={() => copy("all", selected.content)}
										className="shrink-0 text-[10px] uppercase tracking-wider text-term-accent hover:underline"
									>
										{copied === "all" ? "copied" : "copy"}
									</button>
								</div>
								<pre className="min-h-0 flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed text-term-fg">
									{selected.content}
								</pre>
							</div>
						) : null}
					</div>
				)}
			</section>
		</div>
	);
}

/** Convenience wrapper that reads the store and renders ArtifactPane. */
export function ArtifactPaneConnected() {
	const { subagents, tearsheetUrl, artifacts } = useQuantStore();
	return <ArtifactPane subagents={subagents} tearsheetUrl={tearsheetUrl} artifacts={artifacts} />;
}
