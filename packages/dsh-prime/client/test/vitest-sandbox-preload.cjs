/**
 * Test-runner preload for the DSH file sandbox.
 *
 * Vite's Windows realpath optimization shells out once per process via
 * `child_process.exec("net use")` with piped stdio. Under the harness
 * sandbox, capturing spawned output through pipes is denied (EPERM), which
 * aborts config bundling before any test runs. Neutralize exactly that
 * command: report failure through the normal callback so vite falls back to
 * plain fs.realpathSync and no console output is captured.
 */
"use strict";

const childProcess = require("node:child_process");

const originalExec = childProcess.exec;
childProcess.exec = function patchedExec(command, ...rest) {
	if (command === "net use") {
		const callback = rest[rest.length - 1];
		if (typeof callback === "function") {
			queueMicrotask(() => callback(new Error("net use disabled under DSH file sandbox")));
		}
		return { on() {}, kill() {}, unref() {}, pid: 0 };
	}
	return originalExec.call(this, command, ...rest);
};
