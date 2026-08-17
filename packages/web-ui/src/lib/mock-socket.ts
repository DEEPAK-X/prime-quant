/**
 * Mock WebSocket replaying recorded v2 bridge events.
 *
 * The GUI develops against the demo backend (protocol v1) for live behavior,
 * but v2-only affordances (chat_delta streaming, thinking accordions, quant
 * cards, agent_state pills, MT5 status) need protocol-2 frames to exercise.
 * This module replays a scripted v2 session through the same WebSocket
 * surface the transport expects, with no network and no real bridge.
 *
 * Opt-in: append `?mock=1` to the GUI URL (or set VITE_USE_MOCK_SOCKET=1 at
 * build time) and the transport swaps `new WebSocket(...)` for
 * `createMockSocket()`. The replay loop answers client->server `chat` with a
 * streaming assistant turn + pipeline steps + a quant card + a tearsheet, so
 * every v2 component path is reachable offline.
 */
import type { ClientMessage, ServerEvent } from "./contract";

type MockReadyState = 0 | 1 | 2 | 3;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class MockSocket {
	readyState: MockReadyState = CONNECTING;
	onopen: ((this: MockSocket, ev: Event) => void) | null = null;
	onmessage: ((this: MockSocket, ev: MessageEvent) => void) | null = null;
	onerror: ((this: MockSocket, ev: Event) => void) | null = null;
	onclose: ((this: MockSocket, ev: CloseEvent) => void) | null = null;
	private timers: ReturnType<typeof setTimeout>[] = [];
	private sent = false;

	constructor() {
		// Async open + hello, mirroring a real socket handshake.
		setTimeout(() => {
			if (this.readyState !== CONNECTING) return;
			this.readyState = OPEN;
			this.onopen?.call(this, new Event("open"));
			this.emit(HELLO);
		}, 20);
	}

	private emit(event: ServerEvent): void {
		if (this.readyState !== OPEN) return;
		this.onmessage?.call(this, { data: JSON.stringify(event) } as MessageEvent);
	}

	send(data: string): void {
		if (this.readyState !== OPEN) return;
		let message: ClientMessage;
		try {
			message = JSON.parse(data) as ClientMessage;
		} catch {
			return;
		}
		if (message.type === "chat" && !this.sent) {
			this.sent = true;
			// Echo the user message back (the store dedupes optimistic sends).
			this.emit({ type: "chat", role: "user", text: message.text, id: `echo-${Date.now()}`, ts: NOW() });
			for (const { delay, event } of buildTurnScript(message.text)) {
				this.timers.push(setTimeout(() => this.emit(event), delay));
			}
		} else if (message.type === "interrupt") {
			for (const timer of this.timers) clearTimeout(timer);
			this.timers = [];
			this.emit({ type: "agent_state", state: "ready", detail: "interrupted" });
		}
	}

	close(code = 1000): void {
		this.readyState = CLOSING;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers = [];
		this.readyState = CLOSED;
		this.onclose?.call(this, new CloseEvent("close", { code }));
	}
}

/** Recorded v2 session: hello snapshot. */
const HELLO: ServerEvent = {
	type: "hello",
	protocol: 2,
	backend: "bridge",
	agentState: "ready",
	sessionId: "gui-session",
	mt5: {
		status: "ok",
		detail: { server: "XMGlobal-MT5 6", login: 1301549953, symbols: 1640 },
		checkedAt: "2026-08-17T12:00:00Z",
	},
};

const NOW = () => new Date().toISOString();

/** Scripted assistant turn: deltas -> thinking -> steps -> card -> tearsheet. */
function buildTurnScript(promptText: string): Array<{ delay: number; event: ServerEvent }> {
	const msgId = `msg-${Date.now()}`;
	const thinkId = `think-${Date.now()}`;
	const runId = `run-${Date.now()}`;
	const reply = `Analyzed **${promptText.slice(0, 60) || "EURUSD M5"}**. Sharpe 1.84, sortino 2.12, max drawdown 4.8%. Equity curve and drawdown heatmap are in the tearsheet.`;
	const chunks = reply.split(" ");
	const script: Array<{ delay: number; event: ServerEvent }> = [
		{ delay: 0, event: { type: "agent_state", state: "busy", detail: "streaming turn" } },
		{
			delay: 60,
			event: {
				type: "error",
				scope: "mt5",
				message: "symbol EURUSD tick stale — refetched from XMGlobal-MT5 6",
				fatal: false,
			},
		},
		{
			delay: 30,
			event: { type: "thinking", id: thinkId, delta: "Planning: fetch bars, run backtest, validate.", done: false },
		},
		{ delay: 120, event: { type: "thinking", id: thinkId, delta: " No lookahead detected.", done: true } },
		{ delay: 200, event: { type: "step", id: `${runId}-fetch_data`, name: "fetch_data", status: "running" } },
		{
			delay: 420,
			event: { type: "step", id: `${runId}-fetch_data`, name: "fetch_data", status: "done", detail: "5000 bars" },
		},
		{ delay: 500, event: { type: "step", id: `${runId}-backtest`, name: "backtest", status: "running" } },
		{
			delay: 820,
			event: { type: "step", id: `${runId}-backtest`, name: "backtest", status: "done", detail: "412 trades" },
		},
		{ delay: 900, event: { type: "step", id: `${runId}-cpcv_gate`, name: "cpcv_gate", status: "running" } },
		{
			delay: 1180,
			event: {
				type: "step",
				id: `${runId}-cpcv_gate`,
				name: "cpcv_gate",
				status: "done",
				detail: "dsr 1.32 pbo 0.11",
			},
		},
	];
	let t = 1300;
	for (const word of chunks) {
		script.push({ delay: t, event: { type: "chat_delta", id: msgId, delta: `${word} ` } });
		t += 45;
	}
	script.push({
		delay: t + 60,
		event: {
			type: "card",
			id: `card-${Date.now()}`,
			title: `Backtest ${promptText.slice(0, 24) || "EURUSD M5"}`,
			payload: {
				status: "success",
				metrics: {
					sharpe_ratio: 1.84,
					sortino_ratio: 2.12,
					calmar_ratio: 1.95,
					max_drawdown_pct: 4.8,
					profit_factor: 1.72,
					win_rate: 0.54,
					trades_count: 412,
				},
				validation_gate: { passed: true, deflated_sharpe: 1.32, pbo: 0.11, oos_degradation_pct: 22.4 },
			},
		},
	});
	script.push({
		delay: t + 120,
		event: {
			type: "tearsheet",
			url: "/reports/tearsheet_EURUSD_M5.html",
			name: "tearsheet_EURUSD_M5.html",
			ts: NOW(),
		},
	});
	script.push({
		delay: t + 180,
		event: {
			type: "artifact",
			kind: "py",
			name: "eurusd_m5_mean_reversion.py",
			content:
				"# mean reversion strategy\nfrom primequant.strategy.base import StrategySpec\nspec = StrategySpec(symbol='EURUSD', timeframe='M5')\n",
		},
	});
	script.push({ delay: t + 240, event: { type: "agent_state", state: "ready", detail: "idle" } });
	script.push({ delay: t + 300, event: { type: "chat", role: "assistant", text: reply, id: msgId, ts: NOW() } });
	return script;
}

export function shouldUseMockSocket(): boolean {
	if (typeof window === "undefined") return false;
	const params = new URLSearchParams(window.location.search);
	return params.get("mock") === "1";
}

export function createMockSocket(): MockSocket {
	return new MockSocket();
}
