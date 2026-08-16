# 05 — Integration and Verification

## Development rhythm (both agents)

1. Work feature-branch: `git checkout -b gui/a-<topic>` or `gui/b-<topic>`
2. Commit early, small, and green (`npm run check` passes pre-commit anyway)
3. Push your branch, PR into `main` — **do not merge your own PR**; the owner
   reviews and merges
4. If a PR touches the other agent's files, request their review in the PR
   description
5. Contract disputes (`02-api-contract.md`): open an issue titled
   `contract: <topic>`, both agents must comment agreement before either
   changes the doc; doc changes land as their own commit referencing the issue

## Parallel-work safety

- You can develop fully against the other side's *contract*, not code:
  - Agent A tests with `wscat`/small Node scripts (see 03 acceptance tests)
  - Agent B tests against `demo-backend.mjs` (protocol v1) plus a
    `src/lib/mock-socket.ts` fixture replaying recorded v2 event scripts
    (B-agent owns this file; record real bridge sessions once available)
- Merge order: whichever PR is ready first; rebase the second one on it.

## Integration phase (after A-M5 and B-B2 are merged)

Run on the Windows machine with MT5 open:

```bash
git pull
npm install        # new workspace deps from both agents
npm run gui:live   # Vite :5173 + bridge :3001 + agent child
```

Then execute this script verbatim and record results in the PR:

| # | Step | Expected |
|---|---|---|
| 1 | Open http://localhost:5173 | Shell renders, no DEMO badge, agent pill `starting`→`ready` within 60 s |
| 2 | MT5 pill | `ok · XMGlobal-MT5 6` after ≤30 s |
| 3 | Send "hello" | Streaming reply with visible cursor; final markdown renders |
| 4 | Send "Pull 5000 EURUSD M5 bars with rlm.quant.fetch_data and summarise QA" | `fetch_data` step chip runs→done; a `card` with `qa` renders; `df` fetch acknowledged in reply |
| 5 | Send "Run the full pipeline on an SMA 10/30 cross and give me the tearsheet" | Steps lint→backtest→gate→tearsheet animate; QuantCard with metrics + PASS/FAIL verdict; artifact pane auto-loads the tearsheet iframe |
| 6 | Click the tearsheet "open in browser" | Report HTML opens |
| 7 | Send "stop" mid-run then press Esc in composer | Agent interrupts; state returns to `ready` |
| 8 | Kill the agent child (Task Manager → node) | Bridge shows `error`, auto-restarts, GUI reconnects and recovers |
| 9 | Close MT5 terminal, click MT5 pill refresh | `down` within 10 s; no other functionality degrades |
| 10 | Stop bridge (Ctrl+C), restart | GUI reconnects (backoff), REST snapshots restore state |
| 11 | `npm run gui` (demo path) | DEMO badge, v1 events still render — fallback intact |
| 12 | `npm run check` | Passes clean |

## Performance budgets

- Bridge resident memory < 150 MB (agent child excluded)
- Event translation latency (RPC line in → WS frame out) < 10 ms p95
- GUI: no dropped frames while streaming at 50 deltas/s (throttle renders by
  rAF batching in the store, not per-delta setState)
- Tearsheet iframe loads < 1 s for a 100 KB report

## Definition of done (whole feature)

- [ ] All 12 integration rows pass on Windows
- [ ] Both agents' milestone acceptance lists checked off in their PRs
- [ ] Legacy Phase 8A routes removed: `/api/chat` NDJSON and `/ws/events`
      deleted together with their tests once v2 covers them (single cleanup
      commit, both agents review)
- [ ] `packages/web-ui/README.md` updated: `npm run gui` (demo) vs
      `npm run gui:live` (real) documented
- [ ] Changelog entries under `packages/web-ui/CHANGELOG.md` and
      `packages/web-ui-server/CHANGELOG.md` `[Unreleased]`
- [ ] No TODOs left in shipped files; contract doc matches implementation
