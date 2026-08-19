/**
 * Rooms view: named conversation rooms. The server-side rooms model lands in
 * A2; today there is one live room (#general) bound to the orchestrator
 * chat, and the rest of the plan's defaults are listed as upcoming.
 */
import { ChatPaneConnected } from "../components/ChatPane";

const UPCOMING_ROOMS = ["alerts", "risk-management", "research", "system-updates"] as const;

export function RoomsView() {
	return (
		<div className="flex min-h-0 flex-1">
			<aside className="flex w-[168px] shrink-0 flex-col border-r border-term-border">
				<header className="border-b border-term-border px-3 py-2 text-[9px] uppercase tracking-widest text-term-dim">
					rooms
				</header>
				<button
					type="button"
					aria-current="page"
					className="flex items-center gap-1.5 border-l-2 border-term-accent bg-term-raised px-3 py-1.5 text-left text-xs text-term-accent"
				>
					<span>#</span> general
				</button>
				{UPCOMING_ROOMS.map((room) => (
					<span
						key={room}
						className="flex items-center justify-between px-3 py-1.5 text-xs text-term-dim"
						title="arrives with the rooms model (M2)"
					>
						<span className="flex items-center gap-1.5">
							<span>#</span> {room}
						</span>
						<span className="border border-term-border px-1 text-[9px] uppercase">M2</span>
					</span>
				))}
			</aside>
			<main className="flex min-w-0 flex-1 flex-col">
				<ChatPaneConnected />
			</main>
		</div>
	);
}
