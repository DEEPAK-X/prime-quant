/**
 * Hash-based view routing for the OS shell.
 *
 * No router dependency: the view id lives in the URL hash (`#/rooms`), so the
 * browser back/forward buttons work and a refresh lands on the same view.
 * Unknown hashes fall back to the default view.
 */
import { useEffect, useState } from "react";

export type ViewId =
	| "dashboard"
	| "agents"
	| "rooms"
	| "bots"
	| "training"
	| "knowledge"
	| "tasks"
	| "logs"
	| "settings";

export const DEFAULT_VIEW: ViewId = "rooms";

const VIEW_IDS: ReadonlySet<string> = new Set([
	"dashboard",
	"agents",
	"rooms",
	"bots",
	"training",
	"knowledge",
	"tasks",
	"logs",
	"settings",
]);

export function parseView(hash: string): ViewId {
	const id = hash.replace(/^#\/?/, "").split("/")[0];
	return (VIEW_IDS.has(id) ? id : DEFAULT_VIEW) as ViewId;
}

export function navigate(view: ViewId): void {
	window.location.hash = `/${view}`;
}

export function useHashRoute(): ViewId {
	const [view, setView] = useState<ViewId>(() => parseView(window.location.hash));
	useEffect(() => {
		const onHashChange = () => setView(parseView(window.location.hash));
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	return view;
}
