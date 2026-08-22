import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	DEFAULT_DSH_PORT,
	findDshLauncher,
	findDshPlugin,
	findPreviewBridge,
	launchGui,
	MISSING_DSH_ERROR,
	MISSING_PLUGIN_ERROR,
	planDshLaunch,
	type SpawnGuiFn,
} from "../src/cli/gui-launch.js";

interface FakeFs {
	root: string;
	exists: (path: string) => boolean;
}

const DSH_BIN_REL = "node_modules/@deepseek-ai/dsh/lib/bin.js";

const tempRoots: string[] = [];

afterAll(() => {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}
});

/** Fabricate a checkout tree in a temp dir; the probe answers per fabricated file only. */
function makeTree(files: readonly string[]): FakeFs {
	const root = mkdtempSync(join(tmpdir(), "prime-gui-launch-"));
	tempRoots.push(root);
	const known = new Set<string>();
	for (const file of files) {
		const absolute = resolve(root, file);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, "", "utf8");
		known.add(absolute);
	}
	return { root, exists: (path) => known.has(path) };
}

interface SpawnCall {
	command: string;
	args: readonly string[];
	options: SpawnOptions;
	unrefCalled: boolean;
}

function stubSpawn(calls: SpawnCall[]): SpawnGuiFn {
	return (command, args, options) => {
		const child = {
			on: () => child,
			unref: () => {
				calls[calls.length - 1]!.unrefCalled = true;
			},
		};
		calls.push({ command, args, options, unrefCalled: false });
		return child as unknown as ChildProcess;
	};
}

describe("findPreviewBridge", () => {
	test("walks up from a nested cwd to the checkout root", () => {
		const fs = makeTree(["packages/web-ui/server/preview-bridge.mjs"]);
		expect(findPreviewBridge(join(fs.root, "packages", "web-ui"), fs.exists)).toBe(
			resolve(fs.root, "packages/web-ui/server/preview-bridge.mjs"),
		);
	});

	test("returns undefined when the marker is absent", () => {
		const fs = makeTree(["README.md"]);
		expect(findPreviewBridge(fs.root, fs.exists)).toBeUndefined();
	});
});

describe("findDshPlugin", () => {
	test("walks up to packages/dsh-prime/cordis.patch.yml", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml"]);
		expect(findDshPlugin(join(fs.root, "packages", "dsh-prime", "overlays"), fs.exists)).toBe(
			resolve(fs.root, "packages/dsh-prime/cordis.patch.yml"),
		);
	});

	test("returns undefined without the plugin", () => {
		const fs = makeTree(["packages/web-ui/server/preview-bridge.mjs"]);
		expect(findDshPlugin(fs.root, fs.exists)).toBeUndefined();
	});
});

describe("findDshLauncher", () => {
	test("prefers a local node_modules install", () => {
		const fs = makeTree(["node_modules/@deepseek-ai/dsh/lib/bin.js"]);
		expect(findDshLauncher(fs.root, fs.exists)).toBe(resolve(fs.root, "node_modules/@deepseek-ai/dsh/lib/bin.js"));
	});

	test("returns undefined when neither a local nor the global npm root has DSH", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml"]);
		expect(findDshLauncher(fs.root, fs.exists)).toBeUndefined();
	});
});

describe("planDshLaunch", () => {
	test("plans the launcher form with overlay before app flags", () => {
		const fs = makeTree([
			"packages/dsh-prime/cordis.patch.yml",
			"packages/dsh-prime/overlays/gui-dsh.yml",
			DSH_BIN_REL,
		]);
		const plan = planDshLaunch({ cwd: fs.root, open: false }, fs.exists);
		expect(plan.args).toEqual([
			resolve(fs.root, DSH_BIN_REL),
			"--profile",
			"web",
			"--patch",
			resolve(fs.root, "packages/dsh-prime/overlays/gui-dsh.yml"),
			"--no-open",
			"--port",
			DEFAULT_DSH_PORT,
		]);
		expect(plan.url).toBe(`http://127.0.0.1:${DEFAULT_DSH_PORT}`);
	});

	test("keeps the browser open by default and passes a port override", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml", DSH_BIN_REL]);
		const plan = planDshLaunch({ cwd: fs.root, port: "4000" }, fs.exists);
		expect(plan.args).toEqual([resolve(fs.root, DSH_BIN_REL), "--profile", "web", "--port", "4000"]);
		expect(plan.url).toBe("http://127.0.0.1:4000");
	});

	test("omits --patch when the overlay is absent", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml", DSH_BIN_REL]);
		const plan = planDshLaunch({ cwd: fs.root, open: false }, fs.exists);
		expect(plan.args).toEqual([
			resolve(fs.root, DSH_BIN_REL),
			"--profile",
			"web",
			"--no-open",
			"--port",
			DEFAULT_DSH_PORT,
		]);
	});

	test("fails fast when the plugin is missing", () => {
		const fs = makeTree([DSH_BIN_REL]);
		expect(() => planDshLaunch({ cwd: fs.root }, fs.exists)).toThrow(MISSING_PLUGIN_ERROR);
	});

	test("fails fast when DSH is not installed", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml"]);
		expect(() => planDshLaunch({ cwd: fs.root }, fs.exists)).toThrow(MISSING_DSH_ERROR);
	});
});

describe("launchGui", () => {
	test("native default spawns the preview bridge with --open on 5173", () => {
		const fs = makeTree(["packages/web-ui/server/preview-bridge.mjs"]);
		const calls: SpawnCall[] = [];
		const { child, url } = launchGui({ cwd: fs.root, spawnFn: stubSpawn(calls) });
		expect(url).toBe("http://127.0.0.1:5173");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.command).toBe(process.execPath);
		expect(call.args[0]).toBe(resolve(fs.root, "packages/web-ui/server/preview-bridge.mjs"));
		expect(call.args).toContain("--open");
		expect(call.options.windowsHide).toBe(true);
		expect(call.options.detached).toBe(false);
		expect(call.options.stdio).toBe("inherit");
		expect(call.options.env?.PORT).toBe("5173");
		expect(call.unrefCalled).toBe(false);
		expect(child).toBeDefined();
	});

	test("native honors --no-open and a port override", () => {
		const fs = makeTree(["packages/web-ui/server/preview-bridge.mjs"]);
		const calls: SpawnCall[] = [];
		const { url } = launchGui({ cwd: fs.root, open: false, port: "9000", spawnFn: stubSpawn(calls) });
		expect(url).toBe("http://127.0.0.1:9000");
		expect(calls[0]!.args).not.toContain("--open");
		expect(calls[0]!.options.env?.PORT).toBe("9000");
	});

	test("dsh surface spawns the launcher JS (never a .cmd shim) with windowsHide", () => {
		const fs = makeTree([
			"packages/dsh-prime/cordis.patch.yml",
			"packages/dsh-prime/overlays/gui-dsh.yml",
			DSH_BIN_REL,
		]);
		const calls: SpawnCall[] = [];
		const { url } = launchGui({ cwd: fs.root, open: false, surface: "dsh", spawnFn: stubSpawn(calls) });
		expect(url).toBe(`http://127.0.0.1:${DEFAULT_DSH_PORT}`);
		const call = calls[0]!;
		expect(call.command).toBe(process.execPath);
		expect(call.args[0]).toBe(resolve(fs.root, DSH_BIN_REL));
		expect(call.args[1]).toBe("--profile");
		expect(call.args[2]).toBe("web");
		expect(call.args).toContain("--no-open");
		expect(call.args).toContain("--patch");
		expect(call.args.join(" ")).not.toMatch(/\.cmd/);
		expect(call.options.windowsHide).toBe(true);
		expect(call.options.detached).toBe(false);
	});

	test("dsh surface with stdio ignore detaches and unrefs", () => {
		const fs = makeTree(["packages/dsh-prime/cordis.patch.yml", DSH_BIN_REL]);
		const calls: SpawnCall[] = [];
		launchGui({ cwd: fs.root, open: false, surface: "dsh", stdio: "ignore", spawnFn: stubSpawn(calls) });
		expect(calls[0]!.options.detached).toBe(true);
		expect(calls[0]!.options.stdio).toBe("ignore");
		expect(calls[0]!.unrefCalled).toBe(true);
	});

	test("native surface fails fast outside a checkout", () => {
		const fs = makeTree(["README.md"]);
		expect(() => launchGui({ cwd: fs.root, spawnFn: stubSpawn([]) })).toThrow("The web GUI sources were not found");
	});

	test("dsh surface fails fast without the plugin", () => {
		const fs = makeTree(["README.md"]);
		expect(() => launchGui({ cwd: fs.root, surface: "dsh", spawnFn: stubSpawn([]) })).toThrow(MISSING_PLUGIN_ERROR);
	});
});
