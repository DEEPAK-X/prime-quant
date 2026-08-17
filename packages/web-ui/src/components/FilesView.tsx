/**
 * Artifact file browser: kind tabs (.py / .mq5 / .md) over a list, with a
 * CodeBlock preview of the selected file's content on click. Mirrors the
 * contract's ArtifactStore (keyed by ArtifactKind).
 */
import { useEffect, useState } from "react";
import type { ArtifactKind, ArtifactStore } from "../lib/ws";
import { CodeBlock } from "./CodeBlock";

interface FilesViewProps {
	readonly artifacts: ArtifactStore;
}

const KINDS: Array<{ kind: ArtifactKind; label: string }> = [
	{ kind: "py", label: ".py" },
	{ kind: "mq5", label: ".mq5" },
	{ kind: "md", label: ".md" },
];

// Map artifact kind to a CodeBlock language for highlighting.
const LANG: Record<ArtifactKind, string> = { py: "python", mq5: "mql5", md: "markdown" };

export function FilesView({ artifacts }: FilesViewProps) {
	const [tab, setTab] = useState<ArtifactKind>("py");
	const [selectedName, setSelectedName] = useState<string | null>(null);

	const files = artifacts[tab];
	// Keep the selection valid when switching tabs or when the list changes;
	// default to the most recent file.
	useEffect(() => {
		if (files.length === 0) {
			setSelectedName(null);
			return;
		}
		if (!files.some((file) => file.name === selectedName)) {
			setSelectedName(files[files.length - 1].name);
		}
	}, [files, selectedName]);

	const selected = files.find((file) => file.name === selectedName) ?? null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center border-b border-term-border">
				{KINDS.map(({ kind, label }) => (
					<button
						key={kind}
						type="button"
						onClick={() => setTab(kind)}
						className={`border-r border-term-border px-3 py-2 text-xs uppercase tracking-wider last:border-r-0 ${
							tab === kind ? "bg-term-panel text-term-accent" : "text-term-dim hover:text-term-fg"
						}`}
					>
						{label} <span className="text-term-dim">({artifacts[kind].length})</span>
					</button>
				))}
				<span className="ml-auto pr-3 text-[10px] uppercase tracking-wider text-term-dim">export</span>
			</header>
			{files.length === 0 ? (
				<p className="px-3 py-2 text-[11px] text-term-dim">no {tab} artifacts generated yet</p>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="max-h-[40%] min-h-0 overflow-y-auto border-b border-term-border">
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
						<div className="min-h-0 flex-1 overflow-auto p-2">
							<CodeBlock code={selected.content} language={LANG[selected.kind]} />
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
