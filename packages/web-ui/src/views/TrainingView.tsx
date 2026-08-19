/**
 * Training Room view: optimization and validation activity — Optuna runs
 * surface here as first-class objects in M3; today it renders the real
 * optimize/cpcv gate steps and validation verdicts already in the store.
 */
import { useMemo } from "react";
import { useQuantStore } from "../lib/store";
import type { StepEvent } from "../lib/ws";

const STEP_TONE: Record<StepEvent["status"], string> = {
	running: "text-term-accent",
	done: "text-term-green",
	error: "text-term-red",
};

const TRAINING_STEPS = new Set(["optimize", "cpcv_gate"]);

export function TrainingView() {
	const { steps, cards } = useQuantStore();

	const trainingSteps = useMemo(
		() =>
			Object.values(steps)
				.filter((step) => TRAINING_STEPS.has(step.name))
				.sort((a, b) => a.id.localeCompare(b.id)),
		[steps],
	);

	const gates = useMemo(
		() => Object.values(cards).filter((card) => card.payload.validation_gate !== undefined),
		[cards],
	);

	return (
		<div className="pq-grid-bg min-h-0 flex-1 overflow-y-auto p-4">
			<div className="pq-view-in mx-auto max-w-4xl space-y-4">
				<section className="pq-frame p-4">
					<span className="text-[9px] uppercase tracking-widest text-term-dim">optimization runs</span>
					{trainingSteps.length === 0 ? (
						<p className="mt-2 text-[11px] text-term-dim">
							no optimization activity yet — ask for an Optuna tune in Rooms, e.g. “optimize the sma periods with
							optuna, 50 trials”.
						</p>
					) : (
						<ul className="mt-2 space-y-1.5">
							{trainingSteps.map((step) => (
								<li key={step.id} className="flex items-center gap-3 text-[11px]">
									<span className={`w-16 uppercase ${STEP_TONE[step.status]}`}>{step.status}</span>
									<span className="text-term-fg">{step.name}</span>
									{step.detail ? <span className="truncate text-term-dim">{step.detail}</span> : null}
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="pq-frame p-4">
					<span className="text-[9px] uppercase tracking-widest text-term-dim">validation gate verdicts</span>
					{gates.length === 0 ? (
						<p className="mt-2 text-[11px] text-term-dim">verdicts appear after a pipeline run passes through the CPCV gate.</p>
					) : (
						<ul className="mt-2 space-y-1.5">
							{gates.map((card) => {
								const gate = card.payload.validation_gate;
								return (
									<li key={card.id} className="flex items-center gap-3 text-[11px]">
										<span className={gate?.passed ? "text-term-accent" : "text-term-red"}>
											{gate?.passed ? "PASS" : "FAIL"}
										</span>
										<span className="truncate text-term-fg">{card.title}</span>
									</li>
								);
							})}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}
