import { useEffect, useRef, useState } from "react";
import type { AgentState, ChatMessage, ConnectionState, StepEvent, StepStatus, ThinkingBlock } from "../lib/ws";
import { useQuantStore } from "../lib/store";
import { Composer } from "./Composer";
import { Message } from "./Message";
import { PipelineStrip } from "./PipelineStrip";
import { StepChip } from "./StepChip";
import { Thinking } from "./Thinking";

interface ChatPaneProps {
	readonly connection: ConnectionState;
	readonly agentState: AgentState | null;
	readonly messages: ChatMessage[];
	readonly steps: Record<string, StepEvent>;
	readonly thinking: Record<string, ThinkingBlock>;
	readonly sendMessage: (text: string) => void;
	readonly interrupt: () => void;
}

const STEP_ORDER: Readonly<Record<StepStatus, number>> = { running: 0, done: 1, error: 2 };

export function ChatPane({
	connection,
	agentState,
	messages,
	steps,
	thinking,
	sendMessage,
	interrupt,
}: ChatPaneProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickToBottom, setStickToBottom] = useState(true);

	// Auto-scroll to bottom when new content arrives, unless the user scrolled up.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottom) el.scrollTo({ top: el.scrollHeight });
	}, [messages, steps, thinking, stickToBottom]);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
		setStickToBottom(atBottom);
	};

	const liveSteps = Object.values(steps).sort(
		(a, b) => (STEP_ORDER[a.status] - STEP_ORDER[b.status]) || a.id.localeCompare(b.id),
	);
	const liveThinking = Object.values(thinking);
	// Show the turn rail while steps/thinking exist: live during the turn, then
	// the collapsed thinking accordions + step history persist as a transcript.
	const showLiveRail = liveSteps.length > 0 || liveThinking.length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between border-b border-term-border px-3 py-2">
				<span className="text-xs uppercase tracking-wider text-term-dim">orchestrator // chat</span>
				<span
					className={`text-[10px] uppercase tracking-wider ${
						connection === "open"
							? "text-term-green"
							: connection === "connecting"
								? "text-term-yellow"
								: "text-term-red"
					}`}
				>
					{connection}
				</span>
			</header>
			<PipelineStrip steps={steps} />
			<div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-2">
				{messages.length === 0 && !showLiveRail ? (
					<div className="flex h-full items-center justify-center">
						<p className="max-w-sm text-center text-[11px] leading-relaxed text-term-dim">
							{connection === "closed"
								? "backend unreachable — start the quant daemon on localhost:3001"
								: "no conversation yet — the orchestrator stream appears here"}
						</p>
					</div>
				) : (
					<>
						{messages.map((message, index) => (
							<Message key={message.id ?? index} message={message} />
						))}
						{showLiveRail ? (
							<div className="space-y-2">
								{liveThinking.map((block) => (
									<Thinking key={block.id} block={block} />
								))}
								{liveSteps.length > 0 ? (
									<div className="flex flex-wrap gap-1.5">
										{liveSteps.map((step) => (
											<StepChip key={step.id} step={step} />
										))}
									</div>
								) : null}
							</div>
						) : null}
					</>
				)}
			</div>
			<Composer
				agentState={agentState}
				connection={connection}
				onSend={sendMessage}
				onInterrupt={interrupt}
			/>
		</div>
	);
}

/** Convenience wrapper that reads the store and renders ChatPane. */
export function ChatPaneConnected() {
	const { connection, agentState, messages, steps, thinking, sendMessage, interrupt } = useQuantStore();
	return (
		<ChatPane
			connection={connection}
			agentState={agentState}
			messages={messages}
			steps={steps}
			thinking={thinking}
			sendMessage={sendMessage}
			interrupt={interrupt}
		/>
	);
}
