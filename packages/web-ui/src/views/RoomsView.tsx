/**
 * Rooms view: named message channels. `#general` is the live orchestrator
 * chat; watcher rooms render the bounded room_message log fed by the bridge
 * (A2). Read-only for now — watchers post via the bridge REST intake.
 */
import { useEffect, useRef, useState } from "react";
import { ChatPaneConnected } from "../components/ChatPane";
import { useQuantStore } from "../lib/store";
import type { RoomInfo } from "../lib/ws";

const FALLBACK_ROOMS: RoomInfo[] = [{ id: "general", topic: "orchestrator chat" }];

function RoomLog({ roomId }: { readonly roomId: string }) {
	const { roomMessages } = useQuantStore();
	const scrollRef = useRef<HTMLDivElement>(null);
	const messages = roomMessages[roomId] ?? [];

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight });
	}, [messages.length]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between border-b border-term-border px-3 py-2">
				<span className="text-xs uppercase tracking-wider text-term-dim"># {roomId}</span>
				<span className="text-[10px] uppercase tracking-wider text-term-dim">{messages.length} messages</span>
			</header>
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
				{messages.length === 0 ? (
					<p className="pt-8 text-center text-[11px] text-term-dim">
						nothing here yet — watcher agents post into this room via the bridge.
					</p>
				) : (
					messages.map((message) => (
						<div key={message.id} className="text-[11px] leading-relaxed">
							<div className="flex items-baseline gap-2">
								<span className="text-term-accent">{message.from}</span>
								<span className="text-[9px] text-term-dim">{new Date(message.ts).toLocaleTimeString()}</span>
							</div>
							<p className="mt-0.5 whitespace-pre-wrap break-words text-term-fg">{message.text}</p>
						</div>
					))
				)}
			</div>
		</div>
	);
}

export function RoomsView() {
	const { rooms } = useQuantStore();
	const [selected, setSelected] = useState("general");
	const list = rooms.length > 0 ? rooms : FALLBACK_ROOMS;

	return (
		<div className="flex min-h-0 flex-1">
			<aside className="flex w-[168px] shrink-0 flex-col overflow-y-auto border-r border-term-border">
				<header className="border-b border-term-border px-3 py-2 text-[9px] uppercase tracking-widest text-term-dim">
					rooms
				</header>
				{list.map((room) => {
					const active = selected === room.id;
					return (
						<button
							key={room.id}
							type="button"
							onClick={() => setSelected(room.id)}
							aria-current={active ? "page" : undefined}
							title={room.topic || room.id}
							className={`flex items-center gap-1.5 border-l-2 px-3 py-1.5 text-left text-xs ${
								active
									? "border-term-accent bg-term-raised text-term-accent"
									: "border-transparent text-term-dim hover:bg-term-raised hover:text-term-fg"
							}`}
						>
							<span>#</span> {room.id}
						</button>
					);
				})}
			</aside>
			<main className="flex min-w-0 flex-1 flex-col">
				{selected === "general" ? <ChatPaneConnected /> : <RoomLog roomId={selected} />}
			</main>
		</div>
	);
}
