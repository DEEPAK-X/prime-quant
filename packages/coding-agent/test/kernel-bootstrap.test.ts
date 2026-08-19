import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelBootstrapLogPath,
	getKernelVenvDir,
	type KernelPythonSkill,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function expectedVenvPython(venv: string): string {
	return process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function compileCsharp(source: string, outPath: string): void {
	const srcFile = join(tempDir, `cs_${Date.now()}_${Math.random().toString(36).slice(2)}.cs`);
	writeFileSync(srcFile, source, "utf8");
	execFileSync(
		"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
		["/nologo", `/out:${outPath}`, "/target:exe", srcFile],
		{ windowsHide: true },
	);
}

function resolveQuantEnginePyproject(): string | null {
	const candidates = [
		resolve(process.cwd(), "..", "..", "prime-quant", "pyproject.toml"),
		resolve(process.cwd(), "prime-quant", "pyproject.toml"),
		resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "prime-quant", "pyproject.toml"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	const quantEnginePyproject = resolveQuantEnginePyproject();
	const quantEngine = quantEnginePyproject
		? `sha256:${createHash("sha256").update(readFileSync(quantEnginePyproject)).digest("hex")}`
		: undefined;

	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 8,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			quantEngine,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
			})),
		})}\n`,
	);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const allModules = [...importableModules];
	if (allModules.includes("rlm") && !allModules.includes("primequant")) {
		allModules.push("primequant", "MetaTrader5");
	}
	if (process.platform === "win32") {
		const targetExe = filePath.endsWith(".exe") ? filePath : `${filePath}.exe`;
		const moduleChecks = allModules.map((m) => `code.Contains("${m}")`).join(" || ");
		const runtimeCheck = allModules.includes("rlm") ? 'code.Contains("_harness_methods")' : "false";
		const condition = [moduleChecks, runtimeCheck].filter(Boolean).join(" || ") || "false";
		const source = `
using System;
class Program {
	static int Main(string[] args) {
		if (args.Length >= 2 && args[0] == "-c") {
			string code = args[1];
			if (${condition}) {
				return 0;
			}
			return 1;
		}
		return 0;
	}
}`;
		compileCsharp(source, targetExe);
		return;
	}

	const cases = allModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = allModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${delimiter}${process.env.PATH ? process.env.PATH : ""}`;

	if (process.platform === "win32") {
		const extraChecks = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((m) => `code.Contains("import ${m}")`).join(" || ");
		const pySrc = `
using System;
class Program {
	static int Main(string[] args) {
		if (args.Length >= 2 && args[0] == "-c") {
			string code = args[1];
			if (code.Contains("import ipykernel") || code.Contains("import rlm") || code.Contains("_harness_methods") || code.Contains("primequant") || code.Contains("MetaTrader5") || ${extraChecks}) {
				return 0;
			}
			return 1;
		}
		return 0;
	}
}`;
		const uvSrc = `
using System;
using System.IO;
class Program {
	static int Main(string[] args) {
		string logFile = Environment.GetEnvironmentVariable("UV_LOG") ?? "";
		if (!string.IsNullOrEmpty(logFile)) {
			File.AppendAllText(logFile, string.Join(" ", args) + Environment.NewLine);
		}
		if (args.Length > 0 && args[0] == "python") {
			return 0;
		}
		if (args.Length > 1 && args[0] == "venv") {
			string venv = args[1];
			string scriptsDir = Path.Combine(venv, "Scripts");
			Directory.CreateDirectory(scriptsDir);
			string pyExe = Path.Combine(scriptsDir, "python.exe");
			File.WriteAllBytes(pyExe, Convert.FromBase64String("BASE64_PLACEHOLDER"));
			return 0;
		}
		if (args.Length > 0 && args[0] == "pip") {
			string failArg = Environment.GetEnvironmentVariable("UV_FAIL_ARG") ?? "";
			if (!string.IsNullOrEmpty(failArg)) {
				foreach (string a in args) {
					if (a == failArg) return 1;
				}
			}
			return 0;
		}
		return 2;
	}
}`;
		const tempPyExe = join(tempDir, "temp_fake_python.exe");
		compileCsharp(pySrc, tempPyExe);
		const pyBytesBase64 = readFileSync(tempPyExe).toString("base64");
		compileCsharp(uvSrc.replace("BASE64_PLACEHOLDER", pyBytesBase64), join(binDir, "uv.exe"));
		return logPath;
	}

	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import ipykernel"|"import rlm"|*"primequant"*) exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("bootstraps a missing venv with uv, ipykernel, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(expectedVenvPython(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toMatchObject({
			schema: 8,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				expectedVenvPython(venv),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(
			expect.arrayContaining([
				"› setting up python kernel (one-time, ~30s)…",
				"› downloading & installing Python 3.11 via uv…",
				"› creating Python virtual environment…",
				"› installing core packages (ipykernel, runtime, dependencies)…",
				"✓ ready",
			]),
		);
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(expectedVenvPython(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(expectedVenvPython(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(expectedVenvPython(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(expectedVenvPython(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			expectedVenvPython(venv),
		);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			expectedVenvPython(venv),
		);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				ipykernel: "ipykernel",
				runtime: "prime-agent-runtime",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [
					{
						importName: pythonSkill.importName,
						packagePath: pythonSkill.packagePath,
						pyprojectPath: pythonSkill.pyprojectPath,
					},
				],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 8,
				ipykernel: "ipykernel",
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("rebuilds a warm venv with a stale rlm runtime", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = expectedVenvPython(venv);
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		if (process.platform === "win32") {
			const source = `
using System;
class Program {
	static int Main(string[] args) {
		if (args.Length >= 2 && args[0] == "-c") {
			string code = args[1];
			if (code.Contains("_harness_methods")) return 1;
			if (code.Contains("import ipykernel") || code.Contains("import rlm")) return 0;
			return 1;
		}
		return 0;
	}
}`;
			compileCsharp(source, python);
		} else {
			writeExecutable(
				python,
				[
					"#!/bin/sh",
					'if [ "$1" = "-c" ]; then',
					'  case "$2" in',
					'    "import ipykernel"|"import rlm") exit 0 ;;',
					"    *) exit 1 ;;",
					"  esac",
					"fi",
					"exit 0",
					"",
				].join("\n"),
			);
		}
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin"), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(expectedVenvPython(venv));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, process.platform === "win32" ? "override-python.exe" : "override-python");
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, process.platform === "win32" ? "override-python.exe" : "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, process.platform === "win32" ? "override-python.exe" : "override-python");
		writeFakePython(overridePython, [
			"ipykernel",
			"rlm",
			...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml"),
		]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, process.platform === "win32" ? "override-python.exe" : "override-python");
		if (process.platform === "win32") {
			const source = `
using System;
class Program {
	static int Main(string[] args) {
		if (args.Length >= 2 && args[0] == "-c") {
			string code = args[1];
			if (code.Contains("_harness_methods")) return 1;
			if (code.Contains("import ipykernel") || code.Contains("import rlm")) return 0;
			return 1;
		}
		return 0;
	}
}`;
			compileCsharp(source, overridePython);
		} else {
			writeExecutable(
				overridePython,
				[
					"#!/bin/sh",
					'if [ "$1" = "-c" ]; then',
					'  case "$2" in',
					'    "import ipykernel"|"import rlm") exit 0 ;;',
					'    *"_harness_methods"*) exit 1 ;;',
					"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
					"    *) exit 1 ;;",
					"  esac",
					"fi",
					"exit 0",
					"",
				].join("\n"),
			);
		}
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, process.platform === "win32" ? "override-python.exe" : "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/missing ipykernel/);
	});

	it("returns the bootstrap log path for a venv", () => {
		const venv = join(tempDir, "custom-venv");
		expect(getKernelBootstrapLogPath(venv)).toBe(join(tempDir, "kernel-bootstrap.log"));
	});

	it("includes the bootstrap log path in error on bootstrap failure", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = "ipykernel";

		const logPath = getKernelBootstrapLogPath(venv);
		await expect(ensureKernelPython()).rejects.toThrow(
			new RegExp(`Bootstrap log: ${logPath.replaceAll("\\", "\\\\")}`),
		);
	});
});
