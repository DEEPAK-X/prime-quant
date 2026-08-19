/**
 * A3 watcher presets: load the PLAN.md watcher prompt presets from
 * `packages/coding-agent/skills/quant/watchers/*.md`, and arm/cancel them
 * through the real `prime-agent schedule` CLI.
 *
 * Arming spawns a one-shot CLI (`schedule add worker <cron> -- <prompt>`);
 * no background process is held by the bridge. Active jobs are always read
 * back from the daemon (`schedule list --all --json`) so the bridge never
 * drifts from the source of truth. All spawns pass `windowsHide: true`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface WatcherPreset {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly cron: string;
	/** Full prompt template handed to `schedule add` when arming. */
	readonly prompt: string;
	/** Room this watcher's cards belong in (PLAN.md mapping). */
	readonly room: string;
}

export interface ActiveWatcher {
	readonly jobId: string;
	readonly agent: string;
	readonly schedule: string;
	readonly message: string;
	readonly nextRunAt: string | null;
}

export interface SpawnResult {
	readonly ok: boolean;
	readonly output: string;
}

export const WATCHER_ROOMS: Record<string, string> = {
	"risk-watcher": "risk-management",
	"flow-watcher": "alerts",
	"research-watcher": "research",
};

const CRON_RE = /prime-agent\s+schedule\s+"([^"]+)"/;
const TITLE_RE = /^#\s+(.+?)\s+Preset/m;

/** Compute the next run for the simple cron forms the presets use. */
export function nextRun(cron: string, from: Date = new Date()): string | null {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [minute, hour] = fields;

	const minuteMatch = /^\*\/(\d+)$/.exec(minute);
	if (minuteMatch) {
		const step = Number(minuteMatch[1]);
		const next = new Date(from);
		next.setSeconds(0, 0);
		next.setMinutes(next.getMinutes() + (step - (next.getMinutes() % step)));
		return next.toISOString();
	}
	if (minute === "*") return from.toISOString();

	const specificMinute = Number(minute);
	const hourMatch = /^\*\/(\d+)$/.exec(hour);
	if (!Number.isNaN(specificMinute) && hourMatch) {
		const step = Number(hourMatch[1]);
		const next = new Date(from);
		next.setSeconds(0, 0);
		next.setMinutes(specificMinute);
		if (next <= from) next.setHours(next.getHours() + 1);
		while (next.getHours() % step !== 0) next.setTime(next.getTime() + 3600_000);
		return next.toISOString();
	}
	return null;
}

const PROMPT_RE = /##\s+Exact Prompt Template\s+```(?:markdown)?\n([\s\S]*?)```/;

/** Parse one watcher preset markdown into a preset, or null when unparseable. */
export function parsePreset(id: string, markdown: string): WatcherPreset | null {
	const title = TITLE_RE.exec(markdown)?.[1];
	const summary = markdown.match(/^#\s+[^\n]+\n+([^#\n][^\n]*)/)?.[1]?.trim();
	const cron = CRON_RE.exec(markdown)?.[1];
	const prompt = PROMPT_RE.exec(markdown)?.[1]?.trim();
	if (!title || !cron || !prompt) return null;
	return { id, title, summary: summary ?? "", cron, prompt, room: WATCHER_ROOMS[id] ?? "alerts" };
}

export async function loadPresets(repoRoot: string): Promise<WatcherPreset[]> {
	const dir = path.join(repoRoot, "packages", "coding-agent", "skills", "quant", "watchers");
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const presets: WatcherPreset[] = [];
	for (const file of entries.sort()) {
		if (!file.endsWith(".md")) continue;
		const id = file.replace(/\.md$/, "");
		try {
			const preset = parsePreset(id, await readFile(path.join(dir, file), "utf-8"));
			if (preset) presets.push(preset);
		} catch {
			// A malformed preset file must not break the bridge.
		}
	}
	return presets;
}

interface ScheduleJob {
	id?: string;
	jobId?: string;
	agent?: string;
	schedule?: string;
	message?: string;
	prompt?: string;
}

/** CLI runner injected for tests; defaults to the real bundle via execFile. */
export type CliRunner = (args: string[]) => Promise<{ code: number; output: string }>;

async function defaultRunner(bundlePath: string, args: string[]): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[bundlePath, ...args],
			{ timeout: 20_000, windowsHide: true },
			(error, stdout, stderr) => {
				resolve({ code: error ? 1 : 0, output: (stdout || stderr || String(error?.message ?? "")).trim() });
			},
		);
	});
}

export class WatcherService {
	private readonly bundlePath: string;
	private readonly runner: CliRunner;
	private readonly checkBundle: boolean;

	constructor(bundlePath: string, runner?: CliRunner) {
		this.bundlePath = bundlePath;
		this.runner = runner ?? ((args) => defaultRunner(this.bundlePath, args));
		this.checkBundle = runner === undefined;
	}

	async spawn(cron: string, prompt: string): Promise<SpawnResult> {
		if (this.checkBundle && !existsSync(this.bundlePath)) {
			return {
				ok: false,
				output: `bundle missing — run \`npm run build\` once (tui:dist builds it): ${this.bundlePath}`,
			};
		}
		const result = await this.runner(["schedule", "add", "worker", cron, "--", prompt]);
		return { ok: result.code === 0, output: result.output };
	}

	async cancel(jobId: string): Promise<SpawnResult> {
		const result = await this.runner(["schedule", "cancel", jobId]);
		return { ok: result.code === 0, output: result.output };
	}

	async list(): Promise<ActiveWatcher[]> {
		const result = await this.runner(["schedule", "list", "--all", "--json"]);
		if (result.code !== 0 || !result.output) return [];
		try {
			const parsed = JSON.parse(result.output) as { jobs?: ScheduleJob[] } | ScheduleJob[];
			const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
			return jobs.map((job) => ({
				jobId: job.jobId ?? job.id ?? "",
				agent: job.agent ?? "worker",
				schedule: job.schedule ?? "",
				message: job.message ?? job.prompt ?? "",
				nextRunAt: nextRun(job.schedule ?? ""),
			}));
		} catch {
			return [];
		}
	}
}
