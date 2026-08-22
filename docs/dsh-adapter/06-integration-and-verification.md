# 06 — Integration and verification

## Development rhythm (all three)

1. Feature branches: `dsh/a-<topic>`, `dsh/b-<topic>`, `dsh/c-<topic>`
2. Small green commits (`npm run check` on every commit)
3. PR into `main`. **Do not merge your own PR.**
4. If a PR touches another agent's files, request their review.
5. Contract disputes: issue title `dsh-contract: <topic>`. All three must
   comment agreement before `02-frozen-contract.md` changes. Doc change is
   its own commit.

## Parallel-work safety

You do **not** need each other's running code:

| Agent | Works against |
|---|---|
| A | Fake RPC child + `02` event table |
| B | `fixtures/*.jsonl` + `02` §5 |
| C | Walk-up path tests + Windows spike; Pattern 3 waits for A's `PrimeTransport` |

Merge order: A0 (package + `prime-events.ts` + patch ids) should land first
so B can drop the stub import and C can point README at real ids. After A0,
A/B/C proceed in parallel.

If A0 is delayed, B uses `client/prime-events.stub.ts` and C writes README
using `02` ids only.

## Integration phase (after A4, B3, C2)

On the Windows machine, MT5 optional (CSV path exists). Idle RAM headroom
matters more than MT5 for this feature.

```
git pull
npm install
# A: plugin in packages/dsh-prime
# C: enable overlay / --surface dsh
```

Record results in the integration PR (C opens it, A and B comment):

| # | Step | Expected |
|---|---|---|
| 1 | `prime-agent gui` (no flags) | Vite GUI on 127.0.0.1:5173, unchanged |
| 2 | `dsh web --no-open` with plugin installed, tool still disabled | DSH boots; no Prime process in Task Manager |
| 3 | Enable `subagent_prime`, send a **coding** question that should stay in DSH | DSH tools answer; Prime still not spawned |
| 4 | Send a prompt that requires `rlm.quant` / pipeline | `subagent_prime` runs; Prime process appears **once** (Phase 2 pool) |
| 5 | Same session, second quant prompt | **No** second Prime process (pool). If Phase 1 ACP only, this fails — do not ship |
| 6 | Card + step nodes in DSH chat | Metric grid, PASS/FAIL, chips; not raw JSON |
| 7 | Tearsheet node | iframe loads `/prime-reports/…`; open-in-browser works |
| 8 | Interrupt mid-run | DSH cancel → Prime abort; pool idle; DSH usable |
| 9 | `GET /prime-reports/../../etc/passwd` (or Windows equivalent) | 400/404, no file |
| 10 | Kill Prime child | Provider errors safely; DSH host stays up; next start respawns pool |
| 11 | Uninstall plugin / don't pass `--surface dsh` | Native GUI and TUI unaffected |
| 12 | `npm run check` | Clean |
| 13 | (C4 only) TUI daemon already running | Second quant prompt does not spawn RPC if attach worked; TUI session not overwritten |

## Performance budgets

- Idle DSH (plugin loaded, no `start`): **0** Prime processes, **0** kernels
- Plugin host overhead: small; do not load the kernel in `apply()`
- Event map (RPC line → SessionEvent append): < 10 ms p95
- Phase 2 second prompt: no kernel cold start
- RSS: write the measured DSH + Prime + kernel numbers from C’s spike into
  the integration PR. If they blow the 8 GB machine with browser + MT5,
  ship as “optional, 16 GB recommended” in C’s README — do not silently
  drop features to fit

## Definition of done (whole feature)

- [ ] A4 + B3 + C2 merged
- [ ] Checklist 1–12 recorded on Windows
- [ ] Native GUI default intact
- [ ] Changelogs: plugin host (A), nodes (B, if user-visible), `--surface dsh` (C)
- [ ] Pattern 3 either merged with fake-client tests or explicitly deferred
      in `packages/coding-agent/docs/dsh.md`
- [ ] No daemon protocol bump

## Git

```
# status first
git status

# add ONLY your files
git add packages/dsh-prime/src/host/provider.ts
git add packages/dsh-prime/test/provider.test.ts

git commit -m "feat(dsh-prime): pooled RPC subagent provider"

git pull --rebase && git push
```

Never `git add -A`. Never force push. Never `--no-verify`.
