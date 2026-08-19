import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
	type BridgeEvent,
	type BridgeSession,
	createGuiBridge,
	type GuiBridge,
	mapSessionEvent,
	resolveArtifactPath,
} from "../src/index.js";

/** Minimal in-memory BridgeSession that captures prompts and emits events. */
function createFakeSession(): BridgeSession & {
	emitted: BridgeEvent[];
	prompts: string[];
	emit(event: BridgeEvent): void;
} {
	const emitted: BridgeEvent[] = [];
	const prompts: string[] = [];
	const listeners = new Set<(event: BridgeEvent) => void>();
	let lastText = "";
	return {
		emitted,
		prompts,
		async prompt(message: string) {
			prompts.push(message);
			lastText = `assistant reply to: ${message}`;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async getLastAssistantText() {
			return lastText;
		},
		emit(event) {
			emitted.push(event);
			for (const listener of listeners) listener(event);
		},
	};
}

function connectWs(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

function wsMessages(ws: WebSocket): Promise<string[]> {
	const messages: string[] = [];
	ws.on("message", (data) => messages.push(data.toString()));
	return new Promise((resolve) => {
		setTimeout(() => resolve(messages), 200);
	});
}

describe("Phase 8A: web GUI bridge event mapping", () => {
	it("maps an rlm_child_update running snapshot to SUBAGENT_SPAWNED", () => {
		const mapped = mapSessionEvent({
			type: "session_event",
			event: {
				type: "rlm_child_update",
				child: { id: "child-1", status: "running", label: "Run walk-forward test", model: "tier:worker" },
			},
		} as never);
		expect(mapped).toEqual({
			type: "SUBAGENT_SPAWNED",
			id: "child-1",
			model_tier: "worker",
			task: "Run walk-forward test",
		});
	});

	it("maps a completed child to SUBAGENT_COMPLETED with the summary card", () => {
		const mapped = mapSessionEvent({
			type: "session_event",
			event: {
				type: "rlm_child_update",
				child: { id: "child-1", status: "done", answerPreview: '{"status":"success"}' },
			},
		} as never);
		expect(mapped).toEqual({
			type: "SUBAGENT_COMPLETED",
			id: "child-1",
			summary_card: '{"status":"success"}',
		});
	});

	it("returns null for unrelated events", () => {
		expect(mapSessionEvent({ type: "connection_status" } as never)).toBeNull();
	});
});

describe("Phase 8A: web GUI bridge HTTP + WebSocket", () => {
	let port = 3990;
	let bridge: GuiBridge | undefined;
	let session: ReturnType<typeof createFakeSession> | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-web-ui-"));
		port += 1;
		session = createFakeSession();
	});

	afterEach(async () => {
		await bridge?.stop();
		bridge = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("boots on the configured port, serves /api/health, and drives a chat turn", async () => {
		bridge = createGuiBridge({ port, host: "127.0.0.1", session: session!, artifactsRoot: tempDir });
		await bridge.start();

		const health = await fetch(`http://127.0.0.1:${port}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ status: "ok" });

		const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "Run walk-forward test" }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		// The prompt reached the session without blocking the bridge.
		expect(session!.prompts).toEqual(["Run walk-forward test"]);

		const ndjson = (await res.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; text?: string });
		expect(ndjson.map((e) => e.type)).toEqual(["turn_start", "assistant_text", "turn_end"]);
		expect(ndjson[1].text).toBe("assistant reply to: Run walk-forward test");
	});

	it("broadcasts structured events to WebSocket clients as the session emits them", async () => {
		bridge = createGuiBridge({ port, host: "127.0.0.1", session: session!, artifactsRoot: tempDir });
		await bridge.start();

		const ws = await connectWs(port);
		const messagesPromise = wsMessages(ws);
		// Emit after the client is connected so it receives the event.
		session!.emit({
			type: "SUBAGENT_SPAWNED",
			id: "child-7",
			model_tier: "worker",
			task: "Run walk-forward test",
		});
		session!.emit({
			type: "ARTIFACT_READY",
			artifactType: "html_tearsheet",
			file_path: "tearsheet.html",
			file_size_kb: 12.4,
		});
		const messages = await messagesPromise;
		ws.close();
		expect(messages.length).toBe(2);
		const first = JSON.parse(messages[0]!) as BridgeEvent;
		expect(first.type).toBe("SUBAGENT_SPAWNED");
		expect(first).toMatchObject({ id: "child-7", model_tier: "worker" });
		const second = JSON.parse(messages[1]!) as BridgeEvent;
		expect(second.type).toBe("ARTIFACT_READY");
	});

	it("serves an allowlisted artifact and rejects path traversal", async () => {
		const sub = join(tempDir, "reports");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "tearsheet.html"), "<html>ok</html>");
		bridge = createGuiBridge({ port, host: "127.0.0.1", session: session!, artifactsRoot: tempDir });
		await bridge.start();

		const ok = await fetch(
			`http://127.0.0.1:${port}/api/artifacts/serve?path=${encodeURIComponent("reports/tearsheet.html")}`,
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("text/html");
		expect(await ok.text()).toBe("<html>ok</html>");

		const escaped = await fetch(
			`http://127.0.0.1:${port}/api/artifacts/serve?path=${encodeURIComponent("../../../etc/passwd")}`,
		);
		expect(escaped.status).toBe(400);
	});
});

describe("resolveArtifactPath traversal guards", () => {
	it("rejects traversal, absolute, and UNC paths", () => {
		const root = resolve("/tmp/artifacts");
		expect(resolveArtifactPath(root, "reports/x.html")).toBe(resolve(root, "reports/x.html"));
		expect(resolveArtifactPath(root, "../../../etc/passwd")).toBeNull();
		expect(resolveArtifactPath(root, "/etc/passwd")).toBeNull();
		expect(resolveArtifactPath(root, "\\\\host\\share")).toBeNull();
		expect(resolveArtifactPath(undefined, "x")).toBeNull();
	});
});
