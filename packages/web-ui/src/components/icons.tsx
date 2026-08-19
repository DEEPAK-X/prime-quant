/**
 * Inline stroke icons for the OS shell nav rail. Dependency-free, 14px grid,
 * geometric so they sit well next to the mono typeface.
 */
import type { JSX } from "react";
import type { ViewId } from "../lib/navigation";

interface IconProps {
	readonly className?: string;
}

function base(props: IconProps, children: JSX.Element | JSX.Element[]): JSX.Element {
	return (
		<svg
			viewBox="0 0 14 14"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.1"
			strokeLinecap="square"
			aria-hidden="true"
			className={props.className}
		>
			{children}
		</svg>
	);
}

const GLYPHS: Record<ViewId, (props: IconProps) => JSX.Element> = {
	dashboard: (p) =>
		base(p, [
			<rect key="a" x="1.5" y="1.5" width="4.5" height="4.5" />,
			<rect key="b" x="8" y="1.5" width="4.5" height="4.5" />,
			<rect key="c" x="1.5" y="8" width="4.5" height="4.5" />,
			<rect key="d" x="8" y="8" width="4.5" height="4.5" />,
		]),
	agents: (p) =>
		base(p, [
			<circle key="a" cx="7" cy="4.5" r="2.5" />,
			<path key="b" d="M2 12.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />,
		]),
	rooms: (p) => base(p, [<path key="a" d="M2 3h10v7H7l-3 2.5V10H2z" />]),
	bots: (p) =>
		base(p, [
			<rect key="a" x="2.5" y="4" width="9" height="7" />,
			<path key="b" d="M7 1.5V4M4.5 7h.01M9.5 7h.01M5 9.5h4" />,
		]),
	training: (p) => base(p, [<path key="a" d="M2 12V6.5L7 2l5 4.5V12M5 12V9h4v3" />]),
	knowledge: (p) => base(p, [<path key="a" d="M3 2h8v10H3zM5.5 5h3M5.5 7.5h3M5.5 10h2" />]),
	tasks: (p) => base(p, [<path key="a" d="M2 4l1.5 1.5L6 3M2 9.5L3.5 11 6 8.5M8 4h4M8 9.5h4" />]),
	logs: (p) => base(p, [<path key="a" d="M2 2.5h10M2 7h10M2 11.5h6" />]),
	settings: (p) =>
		base(p, [
			<circle key="a" cx="7" cy="7" r="2" />,
			<path key="b" d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M10.9 3.1L9.5 4.5M4.5 9.5L3.1 10.9" />,
		]),
};

export function ViewIcon({ view, className }: { readonly view: ViewId; readonly className?: string }) {
	const Glyph = GLYPHS[view];
	return <Glyph className={className} />;
}
