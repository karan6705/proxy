# Handoff

## Contract v2 (final freeze)
`src/types.ts` changed once more, by Karan's decision, and is now frozen for real. Adapt your code to these changes:
1. **`Logic.plan_undo(chain, actions, preferences, now)`.** `actions` (the chain's actions, resolved) is new, so routes can be chosen from each action's category and merchant. (Dhwanil)
2. **`Action.confidence?: number`** (0 to 1), optional. Capture sets it for LLM-extracted Actions and leaves it unset for structured JSON-LD data. (Sarah)
3. **`HumanReply` gains two kinds** (Sarah parses them; the orchestrator acts on them):
   - `{ kind: "stop", received_at }` freezes all undo activity for the human, across every chain, until their next reply. It has no `chain_id`.
   - `{ kind: "correction", chain_id, corrected_text, received_at }` carries a free-text reply such as "ugh no the 13th", with the human's words unchanged. The orchestrator confirms it once with the human before acting.
4. **Chain root rule** (documented on `Logic.trace`): `root_action_id` is the earliest booked action with a mismatch, meaning the non-`message` action with the earliest `received_at`. A message is the root only if the chain has no booked action. In the demo the root is the flight. (Dhwanil)
5. **The airline has no agent.** It is self-serve only (`has_agent: false`). docs/01, 03, 04, 05 and 06 are updated. (Dhwanil, Codex)
6. **The transfer support address is `support@metrotransfer.example`** everywhere. (Dhwanil, Sarah, Codex)
7. **Domains are out of scope.** No new category.


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

### Answers from Karan (to the requests on branch dhwanil)
`src/types.ts` wins over the context docs. Contracts froze at 2:30 PM.
1. **Tests:** `npm test` is `vitest run` and now includes both `src/**/*.test.ts` and `tests/**/*.test.ts`. The Stripe suite is converted to Vitest on karan-codex, and its exclusion goes away when that merges.
2. **`Payments.charge`:** not in the contract. Keep `MerchantDeps.charge` as your own adapter and use `createFakeDeps()` until Codex's `src/stripe/` and Sarah's Inkbox merge. When I mount your routes I'll back `charge` with `src/stripe/charge.ts` and `refund` with `Payments.refund`. The same goes for `deliver(email)`: Sarah implements `Inkbox.sendEmail`, so use your fake until then.
3. **Mismatch fields:** no new fields. Use `item` for wrong quantity and off-task items, `term` for an unexpected or recurring subscription, and `amount` for over budget. `Mismatch.evidence` now exists as an optional structured field, `{ source_action_id, receipt_fields }` (not a string). Fill it when you can.
4. **Domain grace period and final sale:** no new `ActionCategory`. Key the rules table by merchant id (`action.merchant`), and return `kind: "none"` for final-sale items. Whether domains are in scope at all is a product decision for Karan, so it's parked.
5. **`plan_undo` and `negotiate_step` are yours.** `negotiate_step` decides each step from the typed fields. The orchestrator owns the transport, timers, the 3-round limit and the deadline.
6. **Prompt injection:** putting the text in `DenyMsg.reason` is right. `negotiate_step` must read only the structured protocol fields (`type`, `kind`, `amount`, `refund_amount`) and ignore all free text. The orchestrator logs the injected text and never acts on it.
7. **`must_haves`:** `log_intent` stores `constraints.must_haves` unchanged, so your `term:`, `item:`, `size:`, `model:`, `color:` and `plan:` convention works.
8. **Hotel behaviors:** fine as an option on `createMerchants`. The default stays the demo behavior.
- **Task address:** use `@tasks.proxy.example` in tests (e.g. `task_nyc@tasks.proxy.example`) until Sarah reports the Inkbox format.

## Karan's Codex

### Contract v2 changes for src/agent/
- In `src/agent/stub-merchants.ts`: the airline has no agent (`has_agent: false`, no `agent_identity`), and the transfer's `support_email` is `support@metrotransfer.example`.

- Codex now works in ../tripwire-codex on branch karan-codex (renamed from karan/codex, which git cannot hold next to a branch named karan). It merges into karan, not main: commit, then run `git fetch && git rebase origin/karan`, and Karan merges it. Run `npm ci` there first; node_modules is not shared between worktrees.

### Answers from Karan
- Done: the Stripe suite runs under Vitest (exclusion removed). `@anthropic-ai/sdk` and `@modelcontextprotocol/client` (you import it directly) are in package.json, and `tsx` is a dev dependency. `ANTHROPIC_API_KEY=` and `MCP_URL=http://localhost:3000/mcp` are in `.env.example`.
- Done: `POST /demo/reset`, `/demo/confirmation` and `/demo/host-email` exist behind `PROXY_DEMO_ROUTES=1`, with the bodies you described. The logged task now uses real server state, so any task id works, not just `task_demo`.
- Needed from you: `npm run demo:reset` runs `src/agent/reset.ts`, which doesn't exist yet. Please add it as a thin wrapper that calls `resetScriptedDemo(createHttpDemoControl())`.

### Scripted demo: end the agent's session before the late confirmations
- Team rule: the agent may only self-undo free, full-refund, self-serve actions during its session. In the scripted demo the whole chain must go to the human.
- In `src/agent/` scripted mode: after the agent calls `review` and says it is done, call `POST /demo/end-session?task_id=<task_id>` (server started with `PROXY_DEMO_ROUTES=1`), then send the late confirmations.
- Sessions also end on their own after `SESSION_IDLE_MS` without a tool call for the task.
