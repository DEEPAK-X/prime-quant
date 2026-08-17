/**
 * Auto-growing prompt composer.
 *
 * Enter sends, Shift+Enter inserts a newline. While the agent is busy the
 * send button is replaced by a stop button that emits an interrupt. The
 * textarea grows with its content up to a capped height, then scrolls.
 */
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AgentState, ConnectionState } from "../lib/ws";

interface ComposerProps {
	readonly agentState: AgentState | null;
	readonly connection: ConnectionState;
	readonly onSend: (text: string) => void;
	readonly onInterrupt: () => void;
}

const MAX_HEIGHT_PX = 160;

export function Composer({ agentState, connection, onSend, onInterrupt }: ComposerProps) {
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const busy = agentState === "busy";

	// Grow the textarea to fit content, capped.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
	}, [draft]);

	const submit = () => {
		const trimmed = draft.trim();
		if (!trimmed || busy) return;
		onSend(trimmed);
		setDraft("");
	};

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	const disabled = connection === "closed";

	return (
		<form className="flex items-end gap-2 border-t border-term-border p-2" onSubmit={onSubmit}>
			<textarea
				ref={textareaRef}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKeyDown}
				rows={1}
				placeholder={disabled ? "backend unreachable…" : busy ? "agent is working…" : "prompt the orchestrator tier…"}
				className="min-h-[28px] w-full flex-1 resize-none border border-term-border bg-term-bg px-2 py-1 text-xs leading-relaxed text-term-fg outline-none placeholder:text-term-dim focus:border-term-accent"
			/>
			{busy ? (
				<button
					type="button"
					onClick={onInterrupt}
					className="border border-term-red px-3 py-1 text-[10px] uppercase tracking-wider text-term-red hover:bg-term-panel"
				>
					stop
				</button>
			) : (
				<button
					type="submit"
					disabled={disabled || !draft.trim()}
					className="border border-term-accent px-3 py-1 text-[10px] uppercase tracking-wider text-term-accent enabled:hover:bg-term-panel disabled:opacity-40"
				>
					send
				</button>
			)}
		</form>
	);
}
