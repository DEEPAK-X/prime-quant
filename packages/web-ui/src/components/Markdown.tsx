/**
 * Markdown renderer: marked parses, DOMPurify sanitizes.
 *
 * Hardened per doc 04: images are stripped (the GUI never renders inline
 * remote images), and every link opens in a new tab with rel=noopener. The
 * HTML is escaped by marked's tokenizer before rendering, and DOMPurify runs
 * a second pass so assistant-supplied markdown can never inject markup.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

// Strip images entirely; force safe link targets.
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
	if (data.tagName === "img") {
		(node as Element).remove();
	}
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

marked.setOptions({ gfm: true, breaks: false });

export interface MarkdownProps {
	readonly text: string;
}

export function Markdown({ text }: MarkdownProps) {
	const html = useMemo(() => {
		const raw = marked.parse(text, { async: false }) as string;
		return DOMPurify.sanitize(raw, {
			ALLOWED_TAGS: [
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"p",
				"br",
				"hr",
				"ul",
				"ol",
				"li",
				"blockquote",
				"pre",
				"code",
				"em",
				"strong",
				"del",
				"a",
				"table",
				"thead",
				"tbody",
				"tr",
				"th",
				"td",
				"span",
			],
			ALLOWED_ATTR: ["href", "target", "rel", "title"],
		});
	}, [text]);

	return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
