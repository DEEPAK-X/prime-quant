/**
 * Minimal fixed-row-height virtualizer for large uniform lists (agents, log
 * lines). Renders only the rows inside the viewport plus a small overscan,
 * with spacer elements preserving total scroll height. Variable-height
 * content (chat markdown) does not belong here — it is capped upstream
 * (MAX_MESSAGES) instead.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

interface VirtualRowsProps<T> {
	readonly items: readonly T[];
	readonly rowHeight: number;
	readonly overscan?: number;
	readonly className?: string;
	readonly renderRow: (item: T, index: number) => ReactNode;
	readonly empty?: ReactNode;
}

export function VirtualRows<T>({ items, rowHeight, overscan = 4, className, renderRow, empty }: VirtualRowsProps<T>) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(600);

	const onScroll = useCallback(() => {
		const el = containerRef.current;
		if (!el) return;
		setScrollTop(el.scrollTop);
		setViewportHeight(el.clientHeight);
	}, []);

	const range = useMemo(() => {
		const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
		const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
		return { start, end: Math.min(items.length, start + visible) };
	}, [scrollTop, viewportHeight, rowHeight, overscan, items.length]);

	if (items.length === 0) {
		return <div className={className}>{empty ?? null}</div>;
	}

	return (
		<div ref={containerRef} onScroll={onScroll} className={`overflow-y-auto ${className ?? ""}`}>
			<div style={{ height: range.start * rowHeight }} />
			{items.slice(range.start, range.end).map((item, offset) => renderRow(item, range.start + offset))}
			<div style={{ height: (items.length - range.end) * rowHeight }} />
		</div>
	);
}
