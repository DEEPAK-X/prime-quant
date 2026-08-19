/**
 * Tasks view (A3): watcher preset catalog with one-click arm, and the active
 * scheduled jobs with next-run time and the latest card from their room.
 * Presets/active come from the bridge REST surface; last cards come from
 * the live room store.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, PageHeader } from "../components/ui";
import { useQuantStore } from "../lib/store";

interface WatcherPreset {
	id: string;
	title: string;
	summary: string;
	cron: string;
	room: string;
}

interface ActiveWatcher {
	jobId: string;
	agent: string;
	schedule: string;
	message: string;
	nextRunAt: string | null;
}

interface SpawnOutcome {
	ok: boolean;
	output: string;
}

async function fetchJson<T>(path: string): Promise<T | null> {
	try {
		const response = await fetch(`/api${path}`);
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

export function TasksView() {
	const { roomMessages } = useQuantStore();
	const [presets, setPresets] = useState<WatcherPreset[]>([]);
	const [active, setActive] = useState<ActiveWatcher[]>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void fetchJson<{ presets?: WatcherPreset[] }>("/watchers").then((data) => setPresets(data?.presets ?? []));
		void fetchJson<{ active?: ActiveWatcher[] }>("/watchers/active").then((data) => setActive(data?.active ?? []));
	}, []);
	useEffect(refresh, [refresh]);

	const run = useCallback(
		async (action: string, body: Record<string, string>) => {
			setBusyId(action);
			try {
				const response = await fetch(`/api/watchers/${action.toLowerCase() === "arm" ? "spawn" : "cancel"}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const outcome = (await response.json()) as SpawnOutcome;
				setNotice(outcome.output || (outcome.ok ? "ok" : "failed"));
				refresh();
				return outcome.ok;
			} catch (error) {
				setNotice(String(error));
				return false;
			} finally {
				setBusyId(null);
			}
		},
		[refresh],
	);

	return (
		<div className="pq-grid-bg min-h-0 flex-1 overflow-y-auto p-5">
			<PageHeader title="Tasks" description="scheduled watcher agents — risk, flow, and research" />
			<div className="mx-auto max-w-4xl space-y-4 pt-4">
				{notice ? (
					<div className="pq-frame rounded-[10px] px-4 py-2 text-[11px] text-term-dim">
						<span className="font-medium text-term-fg">last action:</span> {notice}
					</div>
				) : null}

				<section>
					<h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-term-dim">presets</h2>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
						{presets.length === 0 ? (
							<p className="text-[11px] text-term-dim">no presets — the quant skill bundle ships risk, flow, and research watchers.</p>
						) : (
							presets.map((preset, index) => (
								<div key={preset.id} className="pq-frame pq-rise rounded-[10px] p-4" style={{ animationDelay: `${index * 60}ms` }}>
									<div className="flex items-start justify-between gap-2">
										<span className="text-xs font-semibold text-term-fg">{preset.title}</span>
										<Badge tone="accent">{preset.cron}</Badge>
									</div>
									<p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-term-dim">{preset.summary}</p>
									<div className="mt-3 flex items-center justify-between">
										<span className="text-[10px] text-term-dim"># {preset.room}</span>
										<button
											type="button"
											disabled={busyId !== null}
											onClick={() => void run("Arm", { id: preset.id })}
											className="rounded-lg bg-term-accent-soft px-2.5 py-1 text-[10px] font-medium text-term-accent transition-colors duration-150 hover:brightness-125 disabled:opacity-50"
										>
											arm
										</button>
									</div>
								</div>
							))
						)}
					</div>
				</section>

				<section>
					<h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-term-dim">
						active <span className="text-term-fg">({active.length})</span>
					</h2>
					{active.length === 0 ? (
						<p className="text-[11px] text-term-dim">no scheduled watchers — arm a preset above.</p>
					) : (
						active.map((job) => {
							const presetRoom = presets.find((preset) => job.message.includes(preset.title))?.room;
							const lastCard = presetRoom ? (roomMessages[presetRoom] ?? []).at(-1) : undefined;
							return (
								<div key={job.jobId} className="pq-frame mb-2 rounded-[10px] px-4 py-3">
									<div className="flex items-center justify-between gap-2">
										<span className="text-[11px] font-medium text-term-fg">{job.jobId}</span>
										<div className="flex items-center gap-2">
											<Badge tone="green">{job.schedule}</Badge>
											<button
												type="button"
												disabled={busyId !== null}
												onClick={() => void run("Cancel", { jobId: job.jobId })}
												className="rounded-lg bg-term-red-soft px-2 py-1 text-[10px] font-medium text-term-red transition-colors duration-150 hover:brightness-125 disabled:opacity-50"
											>
												cancel
											</button>
										</div>
									</div>
									{job.nextRunAt ? (
										<div className="mt-1 text-[10px] text-term-dim">next run {new Date(job.nextRunAt).toLocaleTimeString()}</div>
									) : null}
									{lastCard ? (
										<div className="mt-1.5 truncate text-[10px] text-term-dim" title={lastCard.text}>
											<span className="text-term-accent">{lastCard.from}</span> · {lastCard.text}
										</div>
									) : null}
								</div>
							);
						})
					)}
				</section>
			</div>
		</div>
	);
}
