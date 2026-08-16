# 04 — Agent B: Frontend Redesign

You own `packages/web-ui/src/**` and `packages/web-ui/vite.config.ts`. Do not
touch `packages/web-ui/server/**` (Agent A's) or root `package.json`.

Deliverable: a redesigned GUI implementing `02-api-contract.md` client-side,
visually modeled on the **ZCode harness** layout: left session sidebar,
centered streaming chat, right artifact panel, dark professional theme.

Reference reading before coding:

1. `docs/gui-wiring/02-api-contract.md` — the interface you consume
2. `docs/gui-wiring/01-overview-and-architecture.md` — constraints + why we
   are NOT cloning Vercel ai-chatbot / open-webui (do not propose it)
3. Existing code: `src/App.tsx`, `src/lib/ws.ts`, `src/components/*.tsx`,
   `src/index.css` — the store hook and terminal aesthetic are the baseline
4. `AGENTS.md` — repo rules

## Design spec (ZCode-style)

### Layout (desktop ≥1280px, graceful to 1024)

```
┌────────────────────────────────────────────────────────────────────────┐
│ topbar: primequant // quant-research   [agent_state pill] [MT5 pill]   │
├──────────┬──────────────────────────────────────────┬─────────────────┤
│ sidebar  │ chat (scroll, bottom-anchored)            │ artifact pane   │
│ 220px    │  · user bubbles (right-aligned, subtle)   │  420px, tabs:   │
│          │  · assistant: markdown + streaming cursor │   Tearsheet     │
│ · + New  │  · thinking accordion (collapsed)         │   Files (py/mq5)│
│ · session│  · tool/step chips (inline, live status)  │   Pipeline      │
│   list   │  · quant cards (metric grid)              │                 │
│   (v2,   │────────────────────────────────────────── │ subagent list   │
│   dimmed)│ composer: textarea + send + stop          │ at bottom       │
└──────────┴──────────────────────────────────────────┴─────────────────┘
```

- Sidebar in v1 shows a single session ("gui-session") + a disabled "+ New"
  (tooltip "multi-session in v2") — the structure ships now, the wiring later.
- Chat is the visual center; artifact pane collapsible via topbar toggle
  (persisted in localStorage).

### Theme tokens (extend existing Tailwind config, keep class names `term-*`)

| Token | Value |
|---|---|
| bg base | `#0d1117` |
| bg raised | `#161b22` |
| border | `#2d3748` |
| fg | `#c9d1d9`, dim `#8b949e` |
| accent | `#58a6ff`, green `#3fb950`, yellow `#d29922`, red `#f85149` |
| mono font | `"JetBrains Mono", "Cascadia Code", ui-monospace` (already used) |
| radius | 6px cards, 10px panes |

No gradients, no glassmorphism, no heavy shadows — flat, bordered, terminal-
inspired. The current demo already has the right direction; your job is depth
and polish, not a new art direction.

### Components to build (all under `src/components/`)

| Component | Responsibility |
|---|---|
| `TopBar.tsx` | brand, agent-state pill (color per state), MT5 pill (`ok/down/unknown` + server name), artifact-pane toggle, DEMO badge when protocol v1 |
| `Sidebar.tsx` | session stub, collapsed quant stats (runs count, last verdict) |
| `ChatPane.tsx` (rewrite) | virtualized-enough message list (no lib; cap at 200 rendered + "load earlier"), auto-scroll with user-scroll override |
| `Message.tsx` | user vs assistant styling |
| `Markdown.tsx` | markdown renderer: headings, lists, tables, inline code, links (target=_blank), images off |
| `CodeBlock.tsx` (extend) | language label, copy button, line numbers optional; reuse `lib/highlight.ts` |
| `StreamingCursor.tsx` | pulsing block `▍` while a `chat_delta` stream is open |
| `Thinking.tsx` | accordion, elapsed-time label, monospace dim text, auto-collapse on done |
| `StepChip.tsx` | inline pipeline chip: icon + name + status color + detail tooltip |
| `QuantCard.tsx` | renders `card` events: title row, metric grid (label small caps / value large), validation gate verdict row (PASS green / FAIL red / unknown gray), collapsible raw JSON |
| `TearsheetView.tsx` | iframe with sandbox="allow-same-origin", open-in-browser link, reload button |
| `FilesView.tsx` | artifact list by kind with CodeBlock preview |
| `PipelineView.tsx` | vertical timeline of `step` history grouped by run id |
| `SubagentList.tsx` | rows: name, tier badge, status dot, tokens/min |
| `Composer.tsx` | auto-growing textarea (Enter=send, Shift+Enter=newline), send button, stop button (emits `interrupt`) while `agentState==="busy"` |

### Store (`src/lib/`)

- Extend `ws.ts` to the v2 contract (all event types from `02` §1). Keep the
  reconnect/backoff logic unchanged.
- New `src/lib/store.tsx`: React context provider wrapping the socket, exposing
  typed state slices (messages incl. streaming buffers keyed by id, thinking
  blocks, steps, cards, artifacts, tearsheets, mt5, agentState, protocol).
  Accumulate `chat_delta` by id; on final `chat` replace buffer and append.
- Demo-mode: if no `hello` with `protocol:2` within 2 s, set `protocol:1`,
  show DEMO badge, hide v2-only affordances.

## Milestones

### B1 — Contract layer + shell

- v2 `ws.ts` types + store provider, TopBar/Sidebar/App layout grid, theme
  tokens.
- Acceptance: `npm run gui` (demo backend) renders the new shell; DEMO badge
  shows; all v1 demo events still display; `npm run check` passes.

### B2 — Chat experience

- Markdown, CodeBlock copy, streaming cursor, thinking accordions, step chips
  inline, composer with interrupt.
- Acceptance: run bridge-less demo; then with Agent A's bridge (integration
  phase): a quant prompt streams visibly and steps animate. Unit-test the
  delta accumulator (vitest, run only this file per repo rules).

### B3 — Artifacts + cards

- QuantCard, TearsheetView (iframe), FilesView, PipelineView, SubagentList,
  artifact pane tabs + collapse persistence.
- Acceptance: demo tearsheet renders; `card` event renders a metric grid with
  PASS/FAIL verdict; files list shows content on click.

### B4 — Polish + resilience

- Empty states (no tearsheet yet, no artifacts), error banners (`error` event,
  fatal styling), reconnect toast, keyboard: Ctrl+Enter send, Esc stop.
  a11y: focus rings, aria-labels on icon buttons.
- Acceptance checklist in `05-integration-and-verification.md` §B.

## Hard rules

- No new runtime deps without checking `.npmrc` 7-day rule; markdown rendering:
  use the existing setup — check `packages/web-ui/package.json` first; if a
  renderer is needed, `marked` + `dompurify` are pre-approved choices.
- No `any`; strict types from the contract doc.
- No inline `import()`; top-level imports only.
- Keep `npm run check` green in every commit.
