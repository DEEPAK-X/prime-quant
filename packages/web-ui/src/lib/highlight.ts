/**
 * Dependency-free, escape-first Python highlighter.
 *
 * The source is HTML-escaped before tokenization, so highlighting can never
 * introduce markup from untrusted content. Regex-based on purpose: good enough
 * for strategy snippets in the chat stream, zero dependencies, no CDNs.
 */

const KEYWORDS =
	"def|return|import|from|class|if|elif|else|for|while|and|or|not|in|is|None|True|False|lambda|with|as|try|except|finally|raise|pass|break|continue|yield|global|assert|del";

const BUILTINS =
	"print|len|range|enumerate|zip|map|filter|sum|min|max|abs|round|int|float|str|list|dict|set|tuple|open|isinstance|type|sorted|reversed|next|iter|any|all|repr";

const TOKEN_RE = new RegExp(
	`(#.*$)|('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")|(\\b\\d+(?:\\.\\d+)?\\b)|(@[A-Za-z_]\\w*)|\\b(${KEYWORDS})\\b|\\b(${BUILTINS})\\b|(\\b[A-Za-z_]\\w*(?=\\())`,
	"gm",
);

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function highlightPython(code: string): string {
	const escaped = escapeHtml(code);
	return escaped.replace(
		TOKEN_RE,
		(
			match,
			comment: string | undefined,
			string: string | undefined,
			number: string | undefined,
			decorator: string | undefined,
			keyword: string | undefined,
			builtin: string | undefined,
			call: string | undefined,
		) => {
			if (comment !== undefined) return `<span class="tok-comment">${comment}</span>`;
			if (string !== undefined) return `<span class="tok-string">${string}</span>`;
			if (number !== undefined) return `<span class="tok-number">${number}</span>`;
			if (decorator !== undefined) return `<span class="tok-decorator">${decorator}</span>`;
			if (keyword !== undefined) return `<span class="tok-keyword">${keyword}</span>`;
			if (builtin !== undefined) return `<span class="tok-builtin">${builtin}</span>`;
			if (call !== undefined) return `<span class="tok-call">${call}</span>`;
			return match;
		},
	);
}
