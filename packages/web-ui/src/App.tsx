import { useEffect, useState } from "react";
import { ArtifactPaneConnected } from "./components/ArtifactPane";
import { ChatPaneConnected } from "./components/ChatPane";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QuantStoreProvider, useQuantStore } from "./lib/store";

const ARTIFACT_PANE_KEY = "primequant.artifactPaneOpen";
const NARROW_BREAKPOINT = 1024;

function readArtifactPaneOpen(): boolean {
	try {
		return window.localStorage.getItem(ARTIFACT_PANE_KEY) !== "0";
	} catch {
		return true;
	}
}

function Shell() {
	const { sessionId, messages, steps, tearsheets, protocol, demo, agentState, mt5, connection } = useQuantStore();
	const [artifactPaneOpen, setArtifactPaneOpen] = useState<boolean>(readArtifactPaneOpen);
	const [narrow, setNarrow] = useState<boolean>(() =>
		typeof window === "undefined" ? false : window.innerWidth < NARROW_BREAKPOINT,
	);

	useEffect(() => {
		const onResize = () => setNarrow(window.innerWidth < NARROW_BREAKPOINT);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		try {
			window.localStorage.setItem(ARTIFACT_PANE_KEY, artifactPaneOpen ? "1" : "0");
		} catch {
			// localStorage unavailable (private mode); persistence is best-effort.
		}
	}, [artifactPaneOpen]);

	const showArtifacts = artifactPaneOpen && !narrow;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<TopBar
				protocol={protocol}
				demo={demo}
				agentState={agentState}
				mt5={mt5}
				connection={connection}
				artifactPaneOpen={showArtifacts}
				onToggleArtifactPane={() => setArtifactPaneOpen((open) => !open)}
			/>
			<div className="flex min-h-0 flex-1">
				<Sidebar sessionId={sessionId} messages={messages} steps={steps} tearsheets={tearsheets} />
				<main className="flex min-w-0 flex-1 flex-col border-r border-term-border">
					<ChatPaneConnected />
				</main>
				{showArtifacts ? (
					<aside className="flex w-[420px] min-w-[360px] flex-col">
						<ArtifactPaneConnected />
					</aside>
				) : null}
			</div>
		</div>
	);
}

export default function App() {
	return (
		<QuantStoreProvider>
			<Shell />
		</QuantStoreProvider>
	);
}
