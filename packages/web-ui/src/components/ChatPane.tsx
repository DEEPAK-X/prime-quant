import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ConnectionState, StepEvent } from "../lib/ws";
import { CodeBlock } from "./CodeBlock";
import { PipelineStrip } from "./PipelineStrip";

interface ChatPaneProps {
	connection: ConnectionState;
	messages: ChatEvent[];
	steps: Record<string, StepEvent>;
	sendMessage: (text: string) => void;
}

type MessageBlock =
	| { kind: "text"; text: string }
	| { kind: "code"; language: string; code: string };

function parseCodeBlocks(text: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	const fence = /```([\w+-]*)\s*\n?([\s\S]*?)```/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(text)) !== null) {
		if (match.index > last) {
			blocks.push({ kind: "text", text: text.slice(last, match.index) });
		}
		blocks.push({ kind: "code", language: match[1] || "text", code: match[2] });
		last = fence.lastIndex;
	}
	if (last < text.length) {
		blocks.push({ kind: "text", text: text.slice(last) });
	}
	if (blocks.length === 0) {
		blocks.push({ kind: "text", text });
	}
	return blocks;
}

function ChatMessage({ message }: { message: ChatEvent }) {
	const blocks = useMemo(() => parseCodeBlocks(message.text), [message.text]);
	const isUser = message.role === "user";
	return (
		<div className="flex flex-col gap-1">
			<div className="text-[10px] uppercase tracking-wider text-term-dim">
				<span className={isUser ? "text-term-yellow" : "text-term-accent"}>
					{isUser ? "[you]" : "[orchestrator]"}
				</span>
			</div>
			{blocks.map((block, index) =>
				block.kind === "code" ? (
					<CodeBlock key={index} language={block.language} code={block.code} />
				) : (
					<p key={index} className="whitespace-pre-wrap text-xs leading-relaxed text-term-fg">
						{block.text}
					</p>
				),
			)}
		</div>
	);
}

export function ChatPane({ connection, messages, steps, sendMessage }: ChatPaneProps) {
	const [draft, setDraft] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);

	const submit = () => {
		if (!draft.trim()) return;
		sendMessage(draft);
		setDraft("");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between border-b border-term-border px-3 py-2">
				<span className="text-xs uppercase tracking-wider text-term-dim">orchestrator // chat</span>
				<span
					className={`text-[10px] uppercase tracking-wider ${
						connection === "open" ? "text-term-green" : connection === "connecting" ? "text-term-yellow" : "text-term-red"
					}`}
				>
					{connection}
				</span>
			</header>
			<PipelineStrip steps={steps} />
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
				{messages.length === 0 ? (
					<div className="flex h-full items-center justify-center">
						<p className="max-w-sm text-center text-[11px] leading-relaxed text-term-dim">
							{connection === "closed"
								? "backend unreachable — start the quant daemon on localhost:3001"
								: "no conversation yet — the orchestrator stream appears here"}
						</p>
					</div>
				) : (
					messages.map((message, index) => <ChatMessage key={message.id ?? index} message={message} />)
				)}
			</div>
			<form
				className="flex items-center gap-2 border-t border-term-border p-2"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<input
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="prompt the orchestrator tier..."
					className="min-w-0 flex-1 border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg outline-none placeholder:text-term-dim focus:border-term-accent"
				/>
				<button
					type="submit"
					className="border border-term-accent px-3 py-1 text-[10px] uppercase tracking-wider text-term-accent hover:bg-term-panel"
				>
					send
				</button>
			</form>
		</div>
	);
}
