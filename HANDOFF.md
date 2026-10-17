# Handoff

## Karan

### How to ship the MCP App (live chain) with mcp-use 2.10.1
Found by scaffolding `create-mcp-use-app --template mcp-apps` and reading the installed CLI and types.
- A view is `src/app/<name>/view.tsx` with a default-exported React component. The CLI finds every `<views-dir>/*/view.tsx`; our scripts pass `--views-dir src/app` (the default is `views/`).
- Bind it to a tool with `view: { name: "<name>", description, prefersBorder, csp: { resourceDomains: [...] } }` in `server.tool({...})`. The tool must declare an `outputSchema`; the view reads the tool's `structuredContent`.
- In the view, use hooks from `mcp-use/react`: `useToolContext<"tool-name">()` (pending / error / result), `useCallTool("tool-name")` to call server tools (e.g. poll `get_chain` so rows turn green live), `ThemeProvider`, `useDisplayMode`.
- Typed hooks need the tool constants exported from `src/server.ts`; `npm run typecheck` writes `mcp-env.d.ts` with the type registration.
- `npm run build` bundles views into `.mcp-use/build`; `--inline` embeds view JS/CSS in the MCP resources if a host blocks external assets.
- Dev: `npm run dev` serves `/mcp` and the Inspector at `/inspector` with hot reload.
- Open question: which tool shows the widget. Plan: `get_chain` gets the view, since it returns the per-action state.
- mcp-use 2.10.1, its CLI and inspector require Node >=22.22.2, not Node 18 as AGENTS.md says.

## Sarah

## Dhwanil

## Karan's Codex

### Convert src/stripe/stripe.test.ts to Vitest
- `npm test` now runs every `src/**/*.test.ts` with Vitest. `src/stripe/stripe.test.ts` uses `node:test`, which Vitest can't run, so it is excluded in `vitest.config.ts` for now.
- Please rewrite it with `import { describe, it, expect } from "vitest"`, delete `src/stripe/tsconfig.test.json` if nothing else needs it, and ask Karan (under "Karan") to remove the exclude line.

- Codex now works in ../tripwire-codex on branch karan-codex (renamed from karan/codex, which git cannot hold next to a branch named karan). It merges into karan, not main: commit, then run `git fetch && git rebase origin/karan`, and Karan merges it. Run `npm ci` there first; node_modules is not shared between worktrees.

### Demo agent integration requests
- Live mode is stopped as requested: add `@anthropic-ai/sdk` to `package.json`, add `ANTHROPIC_API_KEY=` to `.env.example`, and provide the key locally. Also add `MCP_URL=http://localhost:3000/mcp` to `.env.example`.
- Alongside `demo:reset`, add package-owned launch scripts for `src/agent/rehearse.ts` and `src/agent/scripted.ts --offline` using the same TypeScript runner chosen for reset.
- Remove the temporary `src/stripe/stripe.test.ts` exclusion from `vitest.config.ts`; the Stripe suite is now converted to Vitest and `src/stripe/tsconfig.test.json` is deleted.
- Scripted mode needs the `PROXY_DEMO_ROUTES=1` server to implement `POST /demo/reset`, `POST /demo/confirmation`, and `POST /demo/host-email`. Reset receives `{clock, preferences}`. Confirmation receives `{action, confirmation, stripe_charge_id, task_email}`. Host email receives `{action, from, to, subject, body}`.
- The stub server currently returns a generated task from `log_intent` but only exposes demo mismatches for hard-coded `task_demo`. Please make the logged scripted-demo task use the demo state so `review` returns the captured host mismatch before session end and the late merchant confirmations extend that chain afterward.

### Scripted demo: end the agent's session before the late confirmations
- Team rule: the agent may only self-undo free, full-refund, self-serve actions during its session. In the scripted demo the whole chain must go to the human.
- In `src/agent/` scripted mode: after the agent calls `review` and says it is done, call `POST /demo/end-session?task_id=<task_id>` (server started with `PROXY_DEMO_ROUTES=1`), then send the late confirmations.
- Sessions also end on their own after `SESSION_IDLE_MS` without a tool call for the task.
