import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Track file descriptors opened in read mode on a directory so the directory
// fsync in compact() can be made to fail without affecting the file fsync.
const directoryReadFds = new Set<number>();
let simulateDirectoryFsyncEperm = false;

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
			const fd = actual.openSync(...args);
			const [path, mode] = args;
			if (mode === "r" && typeof path === "string" && !path.endsWith(".tmp")) {
				directoryReadFds.add(fd);
			}
			return fd;
		}),
		fsyncSync: vi.fn((fd: number) => {
			if (simulateDirectoryFsyncEperm && directoryReadFds.has(fd)) {
				const error: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, fsync");
				error.code = "EPERM";
				throw error;
			}
			return actual.fsyncSync(fd);
		}),
	};
});

const { CommandRecoveryJournal } = await import("../src/modes/daemon/command-recovery-journal.js");
const nodeFs = await import("node:fs");

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("ignores a truncated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});

	it("tolerates a directory fsync that raises EPERM during compaction", () => {
		directoryReadFds.clear();
		simulateDirectoryFsyncEperm = false;
		const fsyncSpy = vi.mocked(nodeFs.fsyncSync);

		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		// Acknowledging the last entry drains the journal and triggers compaction.
		// Enable the EPERM simulation only for the compaction triggered by
		// acknowledge; the preceding appends' file fsyncs must keep succeeding.
		directoryReadFds.clear();
		simulateDirectoryFsyncEperm = true;
		try {
			expect(() => journal.acknowledge("client-a", "command-a")).not.toThrow();
		} finally {
			simulateDirectoryFsyncEperm = false;
		}
		expect(fsyncSpy.mock.calls.length).toBeGreaterThan(0);
		expect(directoryReadFds.size).toBeGreaterThan(0);

		// The compacted journal is reloadable and treats the command as new.
		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});
});
