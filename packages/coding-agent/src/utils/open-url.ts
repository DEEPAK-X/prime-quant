import { execFile } from "node:child_process";
import { win32 as win32Path } from "node:path";

/**
 * Open `url` in the user's default browser, cross-platform, without a shell.
 *
 * Windows uses `rundll32 url.dll,FileProtocolHandler` (no `cmd` / quoting), so
 * it is safe from the shell-injection and `.cmd`-shim problems that `start`
 * would introduce. Best-effort: errors are swallowed because the caller has
 * already printed the URL as a manual fallback.
 */
export function openUrl(url: string): void {
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? [win32Path.join(systemRoot, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	try {
		execFile(command, args, { windowsHide: true }, () => {});
	} catch {
		// Best-effort: caller has printed the URL as a manual fallback.
	}
}
