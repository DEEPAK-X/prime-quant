/**
 * Training Room view (A6): optimization runs as first-class objects and a
 * validation-gate metrics table. Everything is derived from the store —
 * optimize/cpcv steps become run objects, gate cards become structured
 * verdict rows (DSR / PBO / OOS degradation → PASS/FAIL).
 */
import { useMemo } from "react";
import { Badge, PageHeader, type Tone } from "../components/ui";
import { useQuantStore } from "../lib/store";
import type { CardEvent, StepEvent } from "../lib/ws";

const STEP_TONE: Record<StepEvent["status"], Tone> = { running: "accent", done: "green", error: "red" };

const TRAINING_STEPS = new Set(["optimize", "cpcv_gate"]);

function GateRow({ card }: { readonly card: CardEvent }) {
	const gate = card.payload.validation_gate;
	if (!gate) return null;
	const passed = gate.passed === true;
	const metrics = Object.entries(gate).filter(([key]) => key !== "passed");
	return (
		<div className="flex items-center gap-3 border-b border-term-border px-4 py-2.5 last:border-b-0">
			<Badge tone={passed ? "green" : "red"}>{passed ? "PASS" : "FAIL"}</Badge>
			<span className="min-w-0 flex-1 truncate text-[11px] font-medium text-term-fg" title={card.title}>
				{card.title}
			</span>
			<span className="flex shrink-0 gap-3 text-[10px] text-term-dim">
				{metrics.map(([key, value]) => (
					<span key={key}>
						{key.replaceAll("_", " ")} <span className="font-medium text-term-fg">{String(value)}</span>
					</span>
				))}
			</span>
		</div>
	);
}

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
		<div className="pq-grid-bg min-h-0 flex-1 overflow-y-auto">
			<PageHeader title="Training Room" description="optuna optimization runs and overfit gates" />
			<div className="mx-auto max-w-4xl space-y-4 p-5">
				<section className="pq-frame pq-rise rounded-[10px] p-4">
					<h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-term-dim">optimization runs</h2>
					{trainingSteps.length === 0 ? (
						<p className="mt-2 text-[11px] text-term-dim">
							no optimization activity yet — ask for an Optuna tune in Rooms, e.g. “optimize the sma periods with
							optuna, 50 trials”.
						</p>
					) : (
						<ol className="mt-2 space-y-2">
							{trainingSteps.map((step) => (
								<li key={step.id} className="flex items-center gap-3 text-[11px]">
									<Badge tone={STEP_TONE[step.status]}>{step.status}</Badge>
									<span className="font-medium text-term-fg">{step.name}</span>
									{step.detail ? <span className="truncate text-term-dim">{step.detail}</span> : null}
								</li>
							))}
						</ol>
					)}
				</section>

				<section className="pq-frame pq-rise rounded-[10px]" style={{ animationDelay: "120ms" }}>
					<h2 className="px-4 pt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-term-dim">
						validation gate verdicts <span className="text-term-fg">({gates.length})</span>
					</h2>
					{gates.length === 0 ? (
						<p className="px-4 py-3 text-[11px] text-term-dim">
							verdicts appear after a pipeline run passes through the CPCV gate.
						</p>
					) : (
						<div className="mt-2 pb-1">
							{gates.map((card) => (
								<GateRow key={card.id} card={card} />
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
