import { useMemo, useState } from "react";
import { escapeHtml, highlightPython } from "../lib/highlight";

interface CodeBlockProps {
	code: string;
	language: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
	const [copied, setCopied] = useState(false);
	const html = useMemo(
		() => (language === "python" ? highlightPython(code) : escapeHtml(code)),
		[code, language],
	);

	const copy = () => {
		if (!navigator.clipboard) return;
		void navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	};

	return (
		<div className="border border-term-border bg-term-bg">
			<div className="flex items-center justify-between border-b border-term-border px-2 py-1">
				<span className="text-[10px] uppercase tracking-wider text-term-dim">{language || "code"}</span>
				<button
					type="button"
					onClick={copy}
					className="text-[10px] uppercase tracking-wider text-term-accent hover:underline"
				>
					{copied ? "copied" : "copy"}
				</button>
			</div>
			<pre className="overflow-x-auto p-2 text-xs leading-relaxed">
				<code dangerouslySetInnerHTML={{ __html: html }} />
			</pre>
		</div>
	);
}
