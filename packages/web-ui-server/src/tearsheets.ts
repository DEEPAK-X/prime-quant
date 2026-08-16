/**
 * Tearsheets, artifacts, and quant-card sniffing (docs/gui-wiring/03 §M3).
 *
 *   - `sniffCard`: detect compact quant JSON cards in assistant text
 *   - `createTearsheetWatcher`: registry of generated HTML reports, fed by
 *     fs.watch (recursive; Windows-safe) with a debounce, plus explicit
 *     registration of paths seen in card payloads (`report.report_path`)
 *   - `createArtifactScanner`: before/after directory diff around tool
 *     executions to surface generated `.py` / `.mq5` / `.md` files
 *
 * Raw DataFrames, trade lists, and full HTML strings never cross this layer —
 * only compact registry entries and capped file contents.
 */
import {
	type Dirent,
	existsSync,
	type FSWatcher,
	readdirSync,
	readFileSync,
	type Stats,
	statSync,
	watch,
} from "node:fs";
import { join, resolve as pathResolve, relative } from "node:path";

export interface TearsheetEntry {
	name: string;
	url: string;
	ts: string;
}

export interface ArtifactEntry {
	kind: "py" | "mq5" | "md";
	name: string;
	content: string;
}

const CARD_KEYS = ["status", "metrics", "validation_gate", "report", "qa", "optimization"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect a quant summary card in complete assistant text: the trimmed message
 * must parse as JSON and contain at least one card key. Title is
 * `spec.symbol` + timeframe when present, else "Result".
 */
export function sniffCard(text: string): { title: string; payload: Record<string, unknown> } | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isRecord(payload) || !CARD_KEYS.some((key) => Object.hasOwn(payload, key))) {
		return null;
	}
	const spec = isRecord(payload.spec) ? payload.spec : undefined;
	const symbol =
		typeof spec?.symbol === "string" ? spec.symbol : typeof payload.symbol === "string" ? payload.symbol : undefined;
	const timeframe =
		typeof spec?.timeframe === "string"
			? spec.timeframe
			: typeof payload.timeframe === "string"
				? payload.timeframe
				: undefined;
	const title = symbol && timeframe ? `${symbol} ${timeframe}` : "Result";
	return { title, payload };
}

/**
 * Validate a `/reports/<file>` name after decoding: must be a bare filename
 * with no path separators or `..` segments (path-traversal guard on top of
 * `resolveArtifactPath`).
 */
export function safeReportName(decoded: unknown): string | null {
	if (typeof decoded !== "string" || decoded.length === 0 || decoded.length > 255) {
		return null;
	}
	if (decoded.includes("..") || decoded.includes("/") || decoded.includes("\\")) {
		return null;
	}
	return decoded;
}

const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".venv",
	"__pycache__",
	".gui-sessions",
	".next",
	".cache",
	"coverage",
	"target",
]);

const MAX_WALK_FILES = 5000;
const MAX_WALK_DEPTH = 12;

/** Bounded recursive walk returning relative path → absolute path. */
function walk(root: string): Map<string, string> {
	const found = new Map<string, string>();
	const visit = (dir: string, depth: number) => {
		if (depth > MAX_WALK_DEPTH || found.size >= MAX_WALK_FILES) {
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.size >= MAX_WALK_FILES) {
				return;
			}
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) {
					continue;
				}
				visit(abs, depth + 1);
			} else if (entry.isFile()) {
				found.set(relative(root, abs), abs);
			}
		}
	};
	visit(root, 0);
	return found;
}

export interface TearsheetWatcherOptions {
	root: string;
	/** Debounce for fs.watch-triggered rescans, ms. */
	debounceMs?: number;
	/** Fallback polling interval when fs.watch is unavailable, ms. 0 disables. */
	pollIntervalMs?: number;
	/** Called with each new or updated registry entry. */
	onUpdate?: (entry: TearsheetEntry) => void;
}

export interface TearsheetWatcher {
	start(): void;
	stop(): void;
	/** Register a report path (e.g. from `card.payload.report.report_path`). */
	registerPath(absPath: string): void;
	/** Rescan the root for HTML reports now. */
	scan(): void;
	/** Registry entries, newest first. */
	list(): TearsheetEntry[];
	latest(): TearsheetEntry | null;
}

export function createTearsheetWatcher(options: TearsheetWatcherOptions): TearsheetWatcher {
	const root = pathResolve(options.root);
	const debounceMs = options.debounceMs ?? 500;
	const pollIntervalMs = options.pollIntervalMs ?? 0;
	const onUpdate = options.onUpdate ?? (() => {});
	const registry = new Map<string, TearsheetEntry>();
	let watcher: FSWatcher | null = null;
	let pollTimer: NodeJS.Timeout | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;

	const addOrUpdate = (absPath: string): boolean => {
		let stats: Stats;
		try {
			stats = statSync(absPath);
		} catch {
			return false;
		}
		if (!stats.isFile()) {
			return false;
		}
		const name = relative(root, absPath);
		if (name.startsWith("..") || name.includes("/") || name.includes("\\")) {
			return false;
		}
		const entry: TearsheetEntry = {
			name,
			url: `/reports/${encodeURIComponent(name)}`,
			ts: stats.mtime.toISOString(),
		};
		const existing = registry.get(name);
		if (existing && existing.ts === entry.ts) {
			return false;
		}
		registry.set(name, entry);
		onUpdate(entry);
		return true;
	};

	const scan = () => {
		for (const [, absPath] of walk(root)) {
			if (absPath.toLowerCase().endsWith(".html")) {
				addOrUpdate(absPath);
			}
		}
		// Prune entries whose file disappeared (no broadcast for deletions).
		for (const [name] of registry) {
			if (!existsSync(join(root, name))) {
				registry.delete(name);
			}
		}
	};

	const scheduleScan = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			scan();
		}, debounceMs);
	};

	return {
		start() {
			if (watcher || pollTimer) {
				return;
			}
			scan();
			try {
				watcher = watch(root, { recursive: true }, (_eventType, filename) => {
					if (typeof filename === "string" && filename.toLowerCase().endsWith(".html")) {
						scheduleScan();
					}
				});
				watcher.on("error", () => {
					// e.g. inotify limits in containers: fall back to polling.
					watcher?.close();
					watcher = null;
					if (pollIntervalMs > 0 && !pollTimer) {
						pollTimer = setInterval(scan, pollIntervalMs);
					}
				});
			} catch {
				watcher = null;
				if (pollIntervalMs > 0 && !pollTimer) {
					pollTimer = setInterval(scan, pollIntervalMs);
				}
			}
		},
		stop() {
			watcher?.close();
			watcher = null;
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		},
		registerPath(absPath) {
			const resolved = pathResolve(absPath);
			if (!resolved.toLowerCase().endsWith(".html")) {
				return;
			}
			addOrUpdate(resolved);
		},
		scan,
		list() {
			return [...registry.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
		},
		latest() {
			return this.list()[0] ?? null;
		},
	};
}

const INTERESTING_EXTENSIONS = new Set([".py", ".mq5", ".md"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;

export interface ArtifactScannerOptions {
	root: string;
	/** Cap for artifact contents, bytes (default 256 KB). */
	maxBytes?: number;
	/** Called for each detected artifact. */
	onArtifact?: (entry: ArtifactEntry) => void;
}

export interface ArtifactScanner {
	/** Snapshot the current interesting files; call before a tool runs. */
	beforeExecution(): void;
	/** Diff against the before snapshot; read and report new files. */
	afterExecution(): ArtifactEntry[];
}

export function createArtifactScanner(options: ArtifactScannerOptions): ArtifactScanner {
	const root = pathResolve(options.root);
	const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
	const onArtifact = options.onArtifact ?? (() => {});
	let before = new Map<string, string>();

	return {
		beforeExecution() {
			before = walk(root);
		},
		afterExecution() {
			const after = walk(root);
			const entries: ArtifactEntry[] = [];
			for (const [relPath, absPath] of after) {
				if (before.has(relPath)) {
					continue;
				}
				const extension = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
				if (!INTERESTING_EXTENSIONS.has(extension)) {
					continue;
				}
				let content: string;
				try {
					content = readFileSync(absPath, { encoding: "utf8", flag: "r" }).slice(0, maxBytes);
				} catch {
					continue;
				}
				const kind = extension === ".py" ? "py" : extension === ".mq5" ? "mq5" : "md";
				const entry: ArtifactEntry = { kind, name: relPath, content };
				entries.push(entry);
				onArtifact(entry);
			}
			before = after;
			return entries;
		},
	};
}
