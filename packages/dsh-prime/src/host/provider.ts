import {
	concatenateRequestText,
	type PrimeSessionLog,
	type PrimeSubagentProvider,
	type PrimeSubagentRequest,
	type PrimeSubagentResult,
	type PrimeSubagentRun,
} from "../dsh-types.js";
import { MISSING_CLI_ERROR } from "../resolve-cli.js";
import { PoolBusyError, type PrimeRpcPool } from "./pool.js";
import { v2ToPrimeSessionEvents } from "./session-bridge.js";

export { MISSING_CLI_ERROR };

export interface PrimeRpcProviderOptions {
	pool: PrimeRpcPool;
	/** Absolute bundle path; start() fails with MISSING_CLI_ERROR when unset. */
	cliPath: string | undefined;
	sessions?: PrimeSessionLog;
}

class PrimeSubagentRunImpl implements PrimeSubagentRun {
	result: Promise<PrimeSubagentResult>;
	private abortFn: () => Promise<void>;
	private settled = false;

	constructor(work: (run: PrimeSubagentRunImpl) => Promise<PrimeSubagentResult>, abortFn: () => Promise<void>) {
		this.abortFn = abortFn;
		this.result = work(this);
	}

	markSettled(): void {
		this.settled = true;
	}

	async dispose(): Promise<void> {
		if (this.settled) return;
		await this.abortFn();
	}
}

export class PrimeRpcProvider implements PrimeSubagentProvider {
	readonly inheritsParentContext = false as const;
	readonly capabilities: readonly string[] = [];
	private readonly pool: PrimeRpcPool;
	private readonly cliPath: string | undefined;
	private readonly sessions: PrimeSessionLog | undefined;

	constructor(options: PrimeRpcProviderOptions) {
		this.pool = options.pool;
		this.cliPath = options.cliPath;
		this.sessions = options.sessions;
	}

	async start(request: PrimeSubagentRequest): Promise<PrimeSubagentRun> {
		if (!this.cliPath) {
			throw new Error(MISSING_CLI_ERROR);
		}
		const text = concatenateRequestText(request);
		if (!text) {
			throw new Error("subagent_prime requires a non-empty text task");
		}
		await this.pool.ensure();
		if (this.pool.isBusy()) {
			throw new PoolBusyError();
		}

		const unsub = this.pool.subscribe((event) => {
			const appends = v2ToPrimeSessionEvents(event);
			for (const append of appends) {
				this.sessions?.append(append);
			}
		});

		const run = new PrimeSubagentRunImpl(
			async (handle) => {
				try {
					let sawBusy = this.pool.isBusy();
					const idle = new Promise<void>((resolve) => {
						const off = this.pool.subscribe((event) => {
							if (event.type !== "agent_state") return;
							if (event.state === "busy" || event.state === "starting") {
								sawBusy = true;
								return;
							}
							if (sawBusy) {
								off();
								resolve();
							}
						});
					});
					await this.pool.prompt(text);
					if (sawBusy || this.pool.isBusy()) {
						await idle;
					}
					const output = (await this.pool.getLastAssistantText()) ?? "";
					handle.markSettled();
					return { output, stopReason: "completed" as const };
				} catch (error) {
					handle.markSettled();
					if (error instanceof PoolBusyError) {
						throw error;
					}
					const message = error instanceof Error ? error.message : String(error);
					if (/abort/i.test(message)) {
						return { output: "", stopReason: "aborted" as const };
					}
					return { output: message, stopReason: "error" as const };
				} finally {
					unsub();
				}
			},
			() => this.pool.abort(),
		);
		return run;
	}
}
