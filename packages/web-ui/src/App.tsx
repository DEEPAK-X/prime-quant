import { ArtifactPane } from "./components/ArtifactPane";
import { ChatPane } from "./components/ChatPane";
import { useQuantSocket } from "./lib/ws";

export default function App() {
	const { connection, messages, steps, subagents, tearsheetUrl, artifacts, sendMessage } = useQuantSocket();

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center justify-between border-b border-term-border px-3 py-1.5">
				<span className="text-xs font-bold tracking-widest text-term-fg">
					primequant <span className="font-normal text-term-dim">//</span>{" "}
					<span className="font-normal text-term-accent">quant-research terminal</span>
				</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">
					orchestrator <span className="text-term-border">·</span>{" "}
					<span
						className={
							connection === "open"
								? "text-term-green"
								: connection === "connecting"
									? "text-term-yellow"
									: "text-term-red"
						}
					>
						{connection}
					</span>
				</span>
			</header>
			<div className="flex min-h-0 flex-1">
				<main className="flex min-w-0 flex-1 flex-col border-r border-term-border">
					<ChatPane connection={connection} messages={messages} steps={steps} sendMessage={sendMessage} />
				</main>
				<aside className="flex w-[min(46%,520px)] min-w-[360px] flex-col">
					<ArtifactPane subagents={subagents} tearsheetUrl={tearsheetUrl} artifacts={artifacts} />
				</aside>
			</div>
		</div>
	);
}
