/**
 * Honest placeholder for views scheduled in later milestones (M2+). Renders
 * the plan note instead of fake data.
 */
import { navigate } from "../lib/navigation";
import type { ViewId } from "../lib/navigation";

const COPY: Partial<Record<ViewId, { title: string; body: string; milestone: string }>> = {
	knowledge: {
		title: "knowledge base",
		body: "Strategy docs, memory notes, and refined failure patterns will live here once rooms land.",
		milestone: "M2+",
	},
	tasks: {
		title: "tasks",
		body: "Scheduled watcher jobs (Risk, Flow, Research) via prime-agent schedule will be listed here.",
		milestone: "M2",
	},
	logs: {
		title: "logs",
		body: "Daemon and kernel logs, streamed from the existing session worker log files.",
		milestone: "M3",
	},
	settings: {
		title: "settings",
		body: "Provider keys, MT5 credentials, and watcher caps. Today these live in ~/.prime/agent and env vars.",
		milestone: "M4",
	},
};

export function PlaceholderView({ view }: { readonly view: ViewId }) {
	const copy = COPY[view] ?? { title: view, body: "coming in a later milestone.", milestone: "M2+" };
	return (
		<div className="pq-grid-bg flex min-h-0 flex-1 items-center justify-center p-4">
			<div className="pq-frame pq-view-in max-w-md p-6 text-center">
				<div className="text-[9px] uppercase tracking-widest text-term-accent">{copy.milestone}</div>
				<h2 className="mt-1 text-sm font-bold uppercase tracking-widest text-term-fg">{copy.title}</h2>
				<p className="mt-2 text-[11px] leading-relaxed text-term-dim">{copy.body}</p>
				<button
					type="button"
					onClick={() => navigate("rooms")}
					className="mt-4 border border-term-border px-3 py-1 text-[10px] uppercase tracking-wider text-term-dim transition-colors hover:border-term-accent hover:text-term-accent"
				>
					back to rooms
				</button>
			</div>
		</div>
	);
}
