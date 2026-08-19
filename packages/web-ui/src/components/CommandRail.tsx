/**
 * Command rail (right side): agents online, mentions, shared files, pinned.
 * Everything is derived from the live store — no extra sockets, no polling.
 */
import { useMemo } from "react";
import { navigate } from "../lib/navigation";
import type { ArtifactStore, ChatMessage, SubagentEvent, TearsheetEntry } from "../lib/ws";

const MAX_RAIL_ITEMS = 8;
const MENTION_RE = /@you\b/i;

interface CommandRailProps {
	readonly subagents: Record<string, SubagentEvent>;
	readonly messages: ChatMessage[];
	readonly artifacts: ArtifactStore;
	readonly tearsheets: TearsheetEntry[];
}

const AGENT_DOT: Record<SubagentEvent["status"], string> = {
	RUNNING: "bg-term-accent pq-dot-live",
	DONE: "bg-term-green",
	ERROR: "bg-term-red",
};

function RailSection({ title, count, children }: { readonly title: string; readonly count: number; readonly children: React.ReactNode }) {
	return (
		<section className="flex min-h-0 flex-col border-b border-term-border">
			<header className="flex shrink-0 items-center justify-between px-3 py-2">
				<span className="text-[9px] uppercase tracking-widest text-term-dim">{title}</span>
				<span className="text-[9px] text-term-dim">{count}</span>
			</header>
			<div className="min-h-0 overflow-y-auto">{children}</div>
		</section>
	);
}

export function CommandRail({ subagents, messages, artifacts, tearsheets }: CommandRailProps) {
	const agents = useMemo(() => {
		const rank: Record<SubagentEvent["status"], number> = { RUNNING: 0, DONE: 1, ERROR: 2 };
		return Object.values(subagents)
			.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
			.slice(0, MAX_RAIL_ITEMS);
	}, [subagents]);

	const mentions = useMemo(
		() => messages.filter((message) => MENTION_RE.test(message.text)).slice(-MAX_RAIL_ITEMS).reverse(),
		[messages],
	);

	const files = useMemo(() => {
		const artifactFiles = [...artifacts.py, ...artifacts.mq5, ...artifacts.md].map((entry) => ({
			key: `artifact-${entry.kind}-${entry.name}`,
			name: entry.name,
			url: null as string | null,
		}));
		const sheets = tearsheets.map((entry) => ({
			key: `sheet-${entry.url}`,
			name: entry.name ?? entry.url.split("/").pop() ?? entry.url,
			url: entry.url,
		}));
		return [...sheets, ...artifactFiles].slice(0, MAX_RAIL_ITEMS);
	}, [artifacts, tearsheets]);

	return (
		<aside className="flex w-[260px] shrink-0 flex-col border-l border-term-border bg-term-panel">
			<RailSection title="agents online" count={agents.length}>
				{agents.length === 0 ? (
					<p className="px-3 pb-2 text-[10px] text-term-dim">no agents yet</p>
				) : (
					agents.map((agent) => (
						<button
							key={agent.id}
							type="button"
							onClick={() => navigate("agents")}
							className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-term-raised"
						>
							<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[agent.status]}`} />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[11px] text-term-fg">{agent.name}</span>
								{agent.task ? <span className="block truncate text-[9px] text-term-dim">{agent.task}</span> : null}
							</span>
							<span className="shrink-0 text-[9px] uppercase text-term-dim">{agent.tier}</span>
						</button>
					))
				)}
			</RailSection>

			<RailSection title="mentions" count={mentions.length}>
				{mentions.length === 0 ? (
					<p className="px-3 pb-2 text-[10px] text-term-dim">nothing addressed to you</p>
				) : (
					mentions.map((message, index) => (
						<button
							key={message.id ?? index}
							type="button"
							onClick={() => navigate("rooms")}
							className="block w-full truncate px-3 py-1.5 text-left text-[10px] text-term-fg hover:bg-term-raised"
							title={message.text}
						>
							<span className="text-term-accent">{message.role === "assistant" ? "orchestrator" : "you"}</span>
							<span className="text-term-dim"> · {message.text}</span>
						</button>
					))
				)}
			</RailSection>

			<RailSection title="shared files" count={files.length}>
				{files.length === 0 ? (
					<p className="px-3 pb-2 text-[10px] text-term-dim">no artifacts or tearsheets yet</p>
				) : (
					files.map((file) =>
						file.url ? (
							<a
								key={file.key}
								href={file.url}
								target="_blank"
								rel="noreferrer"
								className="block truncate px-3 py-1.5 text-[10px] text-term-fg hover:bg-term-raised"
								title={file.name}
							>
								{file.name}
							</a>
						) : (
							<button
								key={file.key}
								type="button"
								onClick={() => navigate("bots")}
								className="block w-full truncate px-3 py-1.5 text-left text-[10px] text-term-fg hover:bg-term-raised"
								title={file.name}
							>
								{file.name}
							</button>
						),
					)
				)}
			</RailSection>

			<RailSection title="pinned" count={0}>
				<p className="px-3 pb-2 text-[10px] text-term-dim">pinning lands with rooms in M2</p>
			</RailSection>
		</aside>
	);
}
