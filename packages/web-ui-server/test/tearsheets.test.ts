import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactScanner, createTearsheetWatcher, safeReportName, sniffCard } from "../src/tearsheets.js";

describe("sniffCard", () => {
	it("detects a metrics card and derives the title from spec.symbol + timeframe", () => {
		const card = sniffCard(
			JSON.stringify({
				status: "success",
				spec: { symbol: "EURUSD", timeframe: "M5" },
				metrics: { sharpe_ratio: 1.84 },
			}),
		);
		expect(card).not.toBeNull();
		expect(card?.title).toBe("EURUSD M5");
		expect(card?.payload).toMatchObject({ status: "success" });
	});

	it("falls back to top-level symbol/timeframe and to 'Result'", () => {
		const card = sniffCard(JSON.stringify({ symbol: "GBPUSD", timeframe: "H1", qa: { ok: true } }));
		expect(card?.title).toBe("GBPUSD H1");
		expect(sniffCard(JSON.stringify({ status: "success", metrics: {} }))?.title).toBe("Result");
	});

	it("rejects non-JSON text and JSON without any card key", () => {
		expect(sniffCard("hello world")).toBeNull();
		expect(sniffCard("   \n  ")).toBeNull();
		expect(sniffCard(JSON.stringify({ foo: 1, bar: [1, 2] }))).toBeNull();
		expect(sniffCard(JSON.stringify([1, 2, 3]))).toBeNull();
	});

	it("detects validation_gate, report, and optimization keys", () => {
		expect(sniffCard(JSON.stringify({ validation_gate: { passed: true } }))).not.toBeNull();
		expect(sniffCard(JSON.stringify({ report: { report_path: "tearsheet.html" } }))).not.toBeNull();
		expect(sniffCard(JSON.stringify({ optimization: { best_params: {} } }))).not.toBeNull();
	});
});

describe("safeReportName traversal guards", () => {
	it("rejects path separators, .. segments, and empty names", () => {
		expect(safeReportName("tearsheet_EURUSD_M5.html")).toBe("tearsheet_EURUSD_M5.html");
		expect(safeReportName("a/tearsheet.html")).toBeNull();
		expect(safeReportName("a\\tearsheet.html")).toBeNull();
		expect(safeReportName("..")).toBeNull();
		expect(safeReportName("../secret.html")).toBeNull();
		expect(safeReportName("..%2fsecret.html")).toBeNull(); // encoded separators survive decodeURIComponent
		expect(safeReportName("")).toBeNull();
		expect(safeReportName(undefined)).toBeNull();
	});
});

describe("createTearsheetWatcher", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-tearsheets-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers a report path, exposes the /reports/ URL, and lists newest first", async () => {
		const updates: Array<{ name: string }> = [];
		const watcher = createTearsheetWatcher({ root: tempDir, onUpdate: (entry) => updates.push(entry) });
		watcher.start();

		const first = join(tempDir, "tearsheet_old.html");
		writeFileSync(first, "<html>old</html>");
		const second = join(tempDir, "tearsheet_new.html");
		writeFileSync(second, "<html>new</html>");
		// Distinct mtimes so newest-first ordering is deterministic.
		const later = new Date(Date.now() + 60_000);
		utimesSync(second, later, later);

		watcher.registerPath(first);
		watcher.registerPath(second);

		expect(updates.map((entry) => entry.name).sort()).toEqual(["tearsheet_new.html", "tearsheet_old.html"]);
		expect(watcher.latest()?.name).toBe("tearsheet_new.html");
		expect(watcher.latest()?.url).toBe("/reports/tearsheet_new.html");

		// list() is newest-first by mtime.
		const list = watcher.list();
		expect(list[0]!.ts >= list[1]!.ts).toBe(true);

		watcher.stop();
	});

	it("does not update the registry for an unchanged mtime and skips non-HTML paths", () => {
		const updates: Array<{ name: string }> = [];
		const watcher = createTearsheetWatcher({ root: tempDir, onUpdate: (entry) => updates.push(entry) });
		watcher.start();

		const report = join(tempDir, "tearsheet.html");
		writeFileSync(report, "<html>v1</html>");
		watcher.registerPath(report);
		watcher.registerPath(report);
		watcher.registerPath(join(tempDir, "strategy.py"));
		watcher.registerPath(join(tempDir, "nested", "x.html")); // outside the root's direct reports scope

		expect(updates).toHaveLength(1);
		watcher.stop();
	});

	it("scan() picks up new HTML files on disk", () => {
		const watcher = createTearsheetWatcher({ root: tempDir });
		watcher.start();
		writeFileSync(join(tempDir, "tearsheet_EURUSD_M5.html"), "<html>ok</html>");
		watcher.scan();
		expect(watcher.latest()?.name).toBe("tearsheet_EURUSD_M5.html");
		watcher.stop();
	});
});

describe("createArtifactScanner", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-artifacts-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports only files created between before/after snapshots, capped at maxBytes", () => {
		writeFileSync(join(tempDir, "pre_existing.py"), "# existing\n");
		writeFileSync(join(tempDir, "notes.md"), "# notes\n");
		const scanner = createArtifactScanner({ root: tempDir, maxBytes: 64 });
		const reported: string[] = [];
		const scannerWithHook = createArtifactScanner({
			root: tempDir,
			maxBytes: 64,
			onArtifact: (entry) => reported.push(entry.name),
		});

		scannerWithHook.beforeExecution();
		writeFileSync(join(tempDir, "eurusd_m5.py"), "# new strategy\n");
		writeFileSync(join(tempDir, "export.mq5"), "// EA\n");
		writeFileSync(join(tempDir, "summary.md"), "x".repeat(100));
		writeFileSync(join(tempDir, "ignored.txt"), "not interesting\n");

		const entries = scannerWithHook.afterExecution();
		expect(entries.map((entry) => entry.name).sort()).toEqual(["eurusd_m5.py", "export.mq5", "summary.md"]);
		expect(entries.find((entry) => entry.kind === "py")?.content).toBe("# new strategy\n");
		// 100 chars capped at 64 bytes.
		expect(entries.find((entry) => entry.kind === "md")?.content.length).toBe(64);
		expect(reported.sort()).toEqual(["eurusd_m5.py", "export.mq5", "summary.md"]);
		expect(scanner).toBeDefined();
	});

	it("excludes dependency and build directories from the walk", () => {
		mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(tempDir, "node_modules", "pkg", "index.md"), "# dep\n");
		writeFileSync(join(tempDir, "real.md"), "# real\n");
		const scanner = createArtifactScanner({ root: tempDir });
		scanner.beforeExecution();
		writeFileSync(join(tempDir, "node_modules", "pkg", "new.md"), "# new dep file\n");
		writeFileSync(join(tempDir, "new.md"), "# new real file\n");
		const entries = scanner.afterExecution();
		expect(entries.map((entry) => entry.name)).toEqual(["new.md"]);
	});
});
