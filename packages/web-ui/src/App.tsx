import { useEffect, useState } from "react";
import { CommandRail } from "./components/CommandRail";
import { Sidebar } from "./components/Sidebar";
import { StatusToasts } from "./components/StatusToasts";
import { TopBar } from "./components/TopBar";
import { useHashRoute } from "./lib/navigation";
import { QuantStoreProvider, useQuantStore } from "./lib/store";
import { AgentsView } from "./views/AgentsView";
import { BotsView } from "./views/BotsView";
import { DashboardView } from "./views/DashboardView";
import { PlaceholderView } from "./views/PlaceholderView";
import { RoomsView } from "./views/RoomsView";
import { TrainingView } from "./views/TrainingView";

const RAIL_KEY = "primequant.commandRailOpen";
const NARROW_BREAKPOINT = 1024;

function readRailOpen(): boolean {
	try {
		return window.localStorage.getItem(RAIL_KEY) !== "0";
	} catch {
		return true;
	}
}

function Shell() {
	const {
		protocol,
		demo,
		agentState,
		mt5,
		connection,
		errors,
		messages,
		roomMessages,
		subagents,
		artifacts,
		tearsheets,
		backend,
		refreshMt5,
	} = useQuantStore();
	const view = useHashRoute();
	const [railOpen, setRailOpen] = useState<boolean>(readRailOpen);
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
			window.localStorage.setItem(RAIL_KEY, railOpen ? "1" : "0");
		} catch {
			// localStorage unavailable (private mode); persistence is best-effort.
		}
	}, [railOpen]);

	const showRail = railOpen && !narrow;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<TopBar
				protocol={protocol}
				demo={demo}
				agentState={agentState}
				mt5={mt5}
				connection={connection}
				railOpen={showRail}
				onToggleRail={() => setRailOpen((open) => !open)}
				onRefreshMt5={refreshMt5}
			/>
			<StatusToasts errors={errors} connection={connection} />
			<div className="flex min-h-0 flex-1">
				<Sidebar view={view} backend={backend} demo={demo} subagents={subagents} />
				<main className="flex min-w-0 flex-1 flex-col">
					{view === "dashboard" ? <DashboardView /> : null}
					{view === "agents" ? <AgentsView /> : null}
					{view === "rooms" ? <RoomsView /> : null}
					{view === "bots" ? <BotsView /> : null}
					{view === "training" ? <TrainingView /> : null}
					{view === "knowledge" || view === "tasks" || view === "logs" || view === "settings" ? (
						<PlaceholderView view={view} />
					) : null}
				</main>
				{showRail ? (
					<CommandRail
						subagents={subagents}
						messages={messages}
						roomMessages={roomMessages}
						artifacts={artifacts}
						tearsheets={tearsheets}
					/>
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
