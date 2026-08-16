# web-ui

Minimalist, high-density dark terminal GUI for the PrimeQuant orchestrator. Split-pane layout:

- **Left — ChatPane**: monospace conversational stream with the orchestrator tier, syntax-highlighted code blocks, and structured pipeline step indicators (`AST CHECK → BACKTEST → CPCV GATE`).
- **Right — ArtifactPane**: live sub-agent monitor (status badges, worker tier, token rate), embedded iframe tearsheet viewer, and an export drawer with tabs to inspect and copy generated `.py` strategy files and `.mq5` Expert Advisors.

Aesthetic: `#0d1117` background, `1px solid #2d3748` borders, JetBrains Mono / Fira Code, no gradients, no external CDNs (syntax highlighting is a dependency-free escape-first highlighter in `src/lib/highlight.ts`).

## Run

```bash
npm run gui        # from the repo root: Vite dev server on :5173
```

The dev server proxies `/api`, `/artifacts`, and the `/ws` WebSocket stream to the quant backend (daemon) on `localhost:3001`. The backend contract is documented in `src/lib/ws.ts` — event schema for `chat` / `step` / `subagent` / `tearsheet` / `artifact`, plus the REST snapshots (`/api/subagents`, `/api/artifacts?kind=py|mq5`, `/api/tearsheet/latest`) merged on connect.

## Build / check

```bash
npm run build      # tsc --noEmit && vite build
npm run typecheck
```

The package is excluded from the repo-root `tsgo --noEmit` pass (that project is a Node-only, DOM-less environment); web-ui typechecks itself with DOM libs via its own tsconfig.
