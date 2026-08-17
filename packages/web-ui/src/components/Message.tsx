/**
 * A single chat message: user vs assistant styling.
 *
 * User messages render as right-aligned subtle bubbles. Assistant messages
 * render full-width with rich Markdown (headings, lists, tables, inline code,
 * links) plus a streaming cursor while deltas are still arriving. Fenced code
 * blocks are split out and rendered through CodeBlock (copy + Python
 * highlighting) rather than the plain markdown `<pre>`.
 */
import { useMemo } from "react";
import type { ChatMessage } from "../lib/ws";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

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
	return blocks.length === 0 ? [{ kind: "text", text }] : blocks;
}

interface MessageProps {
	readonly message: ChatMessage;
}

export function Message({ message }: MessageProps) {
	const isUser = message.role === "user";
	const blocks = useMemo(() => parseCodeBlocks(message.text), [message.text]);

	if (isUser) {
		return (
			<div className="flex flex-col items-end gap-1">
				<span className="text-[10px] uppercase tracking-wider text-term-yellow">[you]</span>
				<div className="max-w-[85%] border border-term-border bg-term-panel px-2.5 py-1.5 text-xs leading-relaxed text-term-fg">
					<p className="whitespace-pre-wrap">{message.text}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			<span className="text-[10px] uppercase tracking-wider text-term-accent">[orchestrator]</span>
			<div className="space-y-2 text-xs leading-relaxed text-term-fg">
				{blocks.map((block, index) =>
					block.kind === "code" ? (
						<CodeBlock key={index} language={block.language} code={block.code} />
					) : (
						<Markdown key={index} text={block.text} />
					),
				)}
				{message.streaming ? <StreamingCursor /> : null}
			</div>
		</div>
	);
}
