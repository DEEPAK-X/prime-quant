# 04 — Agent B: DSH client UI (ConversationNodes and settings)

You own `packages/dsh-prime/client/**` and `packages/dsh-prime/fixtures/**`.

Do not touch `packages/dsh-prime/src/**` (A), `cordis.patch.yml` (A),
`packages/dsh-prime/README.md` (C), `gui-launch.ts` (C), `packages/web-ui/**`
except **reading** QuantCard/StepChip/TearsheetView as visual references.
Do not import the Vite app.

Deliverable: DSH web-client plugins that fold Agent A's `prime/*` SessionEvents
into chat nodes (card, step, tearsheet, subagent) and a settings card that
shows CLI path / MT5 / pool status. You develop entirely against **fixtures**
so you never wait for A’s RPC pool or a live DSH host.

## Reference reading (this order)

1. `docs/dsh-adapter/01-overview-and-architecture.md`
2. `docs/dsh-adapter/02-frozen-contract.md` §5 (events) and §7 (slots)
3. `packages/dsh-prime/src/prime-events.ts` — **A’s type surface**. If the file
   does not exist yet, copy the payload shapes from `02` §5 into a **temporary**
   `client/prime-events.stub.ts` and switch the import the moment A merges.
   Do not send a PR that permanently duplicates the types.
4. `packages/web-ui/src/components/QuantCard.tsx`
5. `packages/web-ui/src/components/StepChip.tsx`
6. `packages/web-ui/src/components/TearsheetView.tsx`
7. Upstream cookbook (pinned DSH):  
   https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-conversation-node.md  
   and `packages/client/ui-conversation` slot names. **After C’s pin / your
   local `dsh` install, prefer the files in node_modules.** Signatures in this
   doc are indicative; the pinned SDK wins. If they diverge, file `dsh-contract:`.
8. `AGENTS.md`

## Layout you create

```
packages/dsh-prime/
  client/
    tsconfig.json               # DOM + React; NOT picked up by root tsgo
    package.json                # only if the client must be a separate DSH
                                # client module entry. Prefer one package with
                                # export "./client" from the root package.json
                                # — if you need a field in root package.json
                                # exports, ask A via dsh-contract (A owns that
                                # file). Default: A adds
                                # "./client": "./client/index.ts" when you ask.
    index.ts                    # apply(ctx: ClientContext)
    settings.ts                 # settings card apply
    nodes/
      card.ts
      step.ts
      tearsheet.ts
      subagent.ts
    views/
      CardView.tsx
      StepView.tsx
      TearsheetView.tsx
      SubagentView.tsx
    lib/
      title-case.ts
      gate.ts                   # PASS/FAIL from payload.validation_gate
  fixtures/
    turn-backtest.jsonl         # sequence of SessionEvents for one pipeline
    turn-mt5-down.jsonl
    turn-interrupt.jsonl
```

Root tsconfig `include` is `packages/*/src/**` and `packages/*/test/**`.
**Keep client code out of `src/`** so `npm run check` (tsgo) does not parse
React/DOM.

If you add a vitest for match/fold, put it in `packages/dsh-prime/client/test/`
and run from that folder. Do not put DOM tests under `packages/dsh-prime/test/`
(A’s Node suite).

## How DSH client plugins work (contract with reality)

A Conversation Node:

1. `match(event)` → `{ id, role: "start" | "update" }` or `null`
2. `start` / update fold into node state
3. `viewData(state)` → props
4. `ctx.slots.inject('conversation.chat.node', { key: kind }, View)`

You do **not** scan the whole session in the view. You do **not** call Prime
RPC. You do **not** subscribe to v2 WebSockets.

Indicative definition (replace imports with pinned packages):

```ts
const cardDefinition = {
  kind: "prime-card",
  target: "chat",
  match: (event: { type: string; data?: { cardId?: string } }) => {
    if (event.type === "prime/card" && event.data?.cardId) {
      return { id: event.data.cardId, role: "start" as const };
    }
    return null;
  },
};
```

`prime/step` uses `role: "start"` on first `running` and `role: "update"` on
later statuses for the same `stepId`.

## Visual spec (borrow, don’t clone the OS shell)

DSH chrome stays DSH. Your nodes must look like **terminal/quant artifacts
inside a chat transcript**, not a second app frame.

| Node | UI |
|---|---|
| `prime-card` | Title row; metric grid (label small-caps, value large); validation row PASS green / FAIL red / unknown gray; collapsed raw JSON toggle |
| `prime-step` | Inline chip: name (title-case if unknown), status color, `detail` tooltip |
| `prime-tearsheet` | Iframe `sandbox="allow-same-origin"` height ~360px; Reload; Open in browser (`target=_blank` `rel=noopener`). `src` is the event `url` (same origin as DSH host) |
| `prime-subagent` | Name, tier badge, status dot, task text. Upsert by `id` |

Colors: prefer DSH theme tokens if the client theme API exists; otherwise use
the same hex as `docs/gui-wiring/04` (`#3fb950` pass, `#f85149` fail,
`#d29922` running) so QuantCards match the native GUI.

No gradients, no mascot, no community skin system.

## Fixtures (you own these — A’s tests may later reuse them)

`fixtures/turn-backtest.jsonl` — one object per line, **our** `prime/*` plus
minimal native-like assistant chunks if your fold tests need them:

```json
{"type":"prime/step","data":{"stepId":"run-1-ast","name":"ast_check","status":"running"}}
{"type":"prime/step","data":{"stepId":"run-1-ast","name":"ast_check","status":"done"}}
{"type":"prime/step","data":{"stepId":"run-1-bt","name":"backtest","status":"running"}}
{"type":"prime/step","data":{"stepId":"run-1-bt","name":"backtest","status":"done","detail":"sharpe 1.2"}}
{"type":"prime/step","data":{"stepId":"run-1-gate","name":"cpcv_gate","status":"done","detail":"dsr 1.32 · pbo 0.11"}}
{"type":"prime/card","data":{"cardId":"c-run-1","title":"Backtest · EURUSD M5","payload":{"status":"success","metrics":{"sharpe_ratio":1.84},"validation_gate":{"passed":true}}}}
{"type":"prime/tearsheet","data":{"url":"/prime-reports/tearsheet_EURUSD_M5.html","name":"tearsheet_EURUSD_M5.html","ts":"2026-08-22T00:00:00Z"}}
{"type":"prime/subagent","data":{"id":"sub-1","name":"worker://eurusd-m5-scan","tier":"worker","status":"DONE","task":"param sweep"}}
```

`turn-interrupt.jsonl`: a `running` step with no `done` (open chip).
`turn-mt5-down.jsonl`: one `prime/mt5` `{ "status": "down", "detail": null }`.

These fixtures are the contract between you and A. If A’s emitter differs,
**A changes the emitter** or you jointly amend `02`. You do not silently
accept extra fields as required.

## Milestone B0 — Client package + fixtures

- [ ] Directory layout above.
- [ ] `client/tsconfig.json`: `"jsx": "react-jsx"`, DOM lib, `strict`.
- [ ] Fixtures exist and parse as JSONL (small node test or a script A can
      also run). No DSH.

**Acceptance:** a Node test reads the JSONL and asserts 4 `prime/step` lines
in the backtest fixture (or whatever count you wrote — document the count in
the test name).

## Milestone B1 — Match and fold (no React)

Pure functions in `nodes/*.ts`:

- `matchCard`, `foldCard`
- `matchStep`, `foldStep` (upsert by stepId, last status wins)
- `matchTearsheet`, `foldTearsheet`
- `matchSubagent`, `foldSubagent`

**Acceptance:** `client/test/fold.test.ts` replays `turn-backtest.jsonl` and
expects:

- one card state with `passed === true` and `sharpe_ratio === 1.84`
- steps `run-1-ast` done, `run-1-bt` done
- one tearsheet url starting with `/prime-reports/`
- subagent `sub-1` DONE

Unknown event types ignored. `prime/step` with a new name still folds.

## Milestone B2 — React views

Implement the four views. No DSH runtime:

- Card: metrics from `payload.metrics` object keys; gate from
  `payload.validation_gate.passed` (boolean | missing).
- Tearsheet: do not fetch HTML in unit tests; assert the iframe `src` prop.
- Images stripped if you render markdown inside cards (you should not).

If you cannot run React tests without a new jsdom dep, **do not add jsdom**
unless it satisfies 7-day min-release-age. Ship fold tests only and keep
views thin. Note the gap in the PR.

**Acceptance:** views are real `.tsx` files using `createElement` or JSX.
No `any`. No inline `import()`.

## Milestone B3 — `apply` wiring

`client/index.ts`:

```ts
export function apply(ctx: /* pinned ClientContext */): void {
  ctx.conversationEvents.register(cardDefinition);
  ctx.conversationEvents.register(stepDefinition);
  ctx.conversationEvents.register(tearsheetDefinition);
  ctx.conversationEvents.register(subagentDefinition);
  // slots.inject per 02 §7 keys: prime-card, prime-step, prime-tearsheet, prime-subagent
}
```

Exact `ctx` APIs come from pinned DSH. If `conversationEvents` is named
differently, use the pinned name and add a one-line comment citing the
version. Do not wrap in try/catch that swallows registration failure.

**Acceptance:** module exports `apply`. A’s `cordis.patch.yml` row
`prime-client-nodes` points at this module **after** A adds the export —
you request that in `dsh-contract:` if A’s M0 landed without `./client`.

## Milestone B4 — Settings card

`client/settings.ts`:

- Title: `Prime Agent`
- Read-only resolved CLI path (from `GET /prime-status` if A shipped it, else
  a placeholder string `resolved at runtime by host glue`).
- MT5 pill: ok/down/unknown. Click-to-reprobe only if A exposes a POST; v1
  may be display-only — do not invent a daemon call.
- Pool: idle/busy/stopped.
- Copy: “Quant backtests and validation run in Prime Agent via `subagent_prime`.
  Enable the tool in Plugins if it is disabled.”

If DSH settings-card APIs are not available in the pin, ship a Conversation
Node that renders `prime/mt5` as a system row instead, and say so in the PR.

**Acceptance:** settings `apply` is a separate export so A can point
`prime-client-settings` at it. No Prime spawn.

## Hard rules

- You can fully complete B0–B2 before A merges. B3–B4 need pinned DSH type
  names (C’s spike notes or a local `dsh` checkout). Do not block on A’s
  live provider.
- Do not enable `tool-subagent-prime` in the patch file.
- Do not add marked/dompurify if DSH client already ships a markdown
  renderer — use theirs. If you need one, 7-day rule; prefer no extra deps.
- `sandbox` on the iframe. Never `allow-scripts` unless a tearsheet
  **requires** Plotly and you document the XSS tradeoff in the PR; default
  is `allow-same-origin` only (native GUI already uses that).
- Changelog: only when nodes are user-visible in a running DSH (after
  integration). One Unreleased line, append-only, probably on
  `packages/coding-agent/CHANGELOG.md`:
  `Added DeepSeek Harness chat nodes for Prime Quant cards, pipeline steps, and tearsheets.`
- `npm run check` must stay green. If you accidentally put client files under
  `src/`, move them.

## What “done” means for you (before integration)

Fixtures + fold tests pass. Views exist. `apply` compiled against pinned
client types **or** a documented stub with a follow-up issue. You have not
run `dsh web` unless you wanted to; `06` is the live gate.
