/**
 * OS design-system primitives: soft badges, elevated cards, page/section
 * headers. Pure presentational — no state, no store coupling.
 */
import type { ReactNode } from "react";

export type Tone = "accent" | "green" | "red" | "yellow" | "purple" | "dim";

const BADGE_TONE: Record<Tone, string> = {
	accent: "bg-term-accent-soft text-term-accent",
	green: "bg-term-green-soft text-term-green",
	red: "bg-term-red-soft text-term-red",
	yellow: "bg-term-yellow-soft text-term-yellow",
	purple: "bg-term-purple-soft text-term-purple",
	dim: "bg-term-overlay text-term-dim",
};

export function Badge({ tone = "dim", children, title }: { readonly tone?: Tone; readonly children: ReactNode; readonly title?: string }) {
	return (
		<span
			title={title}
			className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${BADGE_TONE[tone]}`}
		>
			{children}
		</span>
	);
}

export function Card({ children, className, interactive }: { readonly children: ReactNode; readonly className?: string; readonly interactive?: boolean }) {
	return (
		<div
			className={`pq-frame rounded-[10px] p-4 ${interactive ? "cursor-pointer" : ""} ${className ?? ""}`}
			role={interactive ? "button" : undefined}
		>
			{children}
		</div>
	);
}

export function PageHeader({ title, description, actions }: { readonly title: string; readonly description?: string; readonly actions?: ReactNode }) {
	return (
		<header className="flex shrink-0 items-baseline justify-between gap-4 border-b border-term-border px-4 py-2.5">
			<div className="min-w-0">
				<h1 className="text-[13px] font-semibold tracking-tight text-term-fg">{title}</h1>
				{description ? <p className="mt-0.5 truncate text-[11px] text-term-dim">{description}</p> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</header>
	);
}

export function SectionHeader({ title, count, actions }: { readonly title: string; readonly count?: number; readonly actions?: ReactNode }) {
	return (
		<header className="flex shrink-0 items-center justify-between gap-2 border-b border-term-border px-3 py-1.5">
			<span className="text-[10px] font-medium uppercase tracking-widest text-term-dim">{title}</span>
			<div className="flex items-center gap-2">
				{count !== undefined ? <span className="text-[10px] text-term-dim">{count}</span> : null}
				{actions}
			</div>
		</header>
	);
}
