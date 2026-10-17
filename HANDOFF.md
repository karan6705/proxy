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
8. **`EventKind` gains `imessage_in`.** Log inbound iMessages with it, not `sms_in` with an `imessage:` outcome. (Sarah)
9. **`Action.confidence`** (item 2) is how capture marks LLM extractions. Actions under 0.5 are dropped and logged, never passed to `onAction`. (Sarah)
10. **Task ids are restricted to `[a-z0-9_]`** (`TASK_ID_PATTERN` in `types.ts`), because a task id becomes an Inkbox handle (`task_demo` becomes `task-demo@...`). `log_intent` returns `invalid_input` otherwise, and so do `review` and `list_chains` for a malformed `task_id`. (Everyone)
- **Sarah, still to adapt from item 3:** the human channel should forward STOP as `{ kind: "stop" }` (it currently ignores it as `opt_out`), and loose replies as `{ kind: "correction", chain_id, corrected_text }` (it currently asks the human to clarify).


## Karan

### How to ship the MCP App (live chain) with mcp-use 2.10.1
- **Status:** the live-chain widget is at `src/app/live-chain/` and shown by `get_chain`. It polls `get_chain` every 2 s and turns a row green only when `stripe_verified` is true.
- **Known limit:** `npm run dev` can't load views from `src/app/`, because the mcp-use 2.10.1 dev server only forwards `/views/...` paths to Vite. To see the widget, use `npm run preview` (build, then start with the inspector at `/inspector`). Deploys use the build, so they're unaffected.
- **No countdown:** `get_chain` has no server time and the demo clock is simulated, so the widget shows when the window closes instead of a countdown.
Found by scaffolding `create-mcp-use-app --template mcp-apps` and reading the installed CLI and types.
- A view is `src/app/<name>/view.tsx` with a default-exported React component. The CLI finds every `<views-dir>/*/view.tsx`; our scripts pass `--views-dir src/app` (the default is `views/`).
- Bind it to a tool with `view: { name: "<name>", description, prefersBorder, csp: { resourceDomains: [...] } }` in `server.tool({...})`. The tool must declare an `outputSchema`; the view reads the tool's `structuredContent`.
- In the view, use hooks from `mcp-use/react`: `useToolContext<"tool-name">()` (pending / error / result), `useCallTool("tool-name")` to call server tools (e.g. poll `get_chain` so rows turn green live), `ThemeProvider`, `useDisplayMode`.
- Typed hooks need the tool constants exported from `src/server.ts`; `npm run typecheck` writes `mcp-env.d.ts` with the type registration.
- `npm run build` bundles views into `.mcp-use/build`; `--inline` embeds view JS/CSS in the MCP resources if a host blocks external assets.
- Dev: `npm run dev` serves `/mcp` and the Inspector at `/inspector` with hot reload.
- Open question: which tool shows the widget. Plan: `get_chain` gets the view, since it returns the per-action state.
- mcp-use 2.10.1, its CLI and inspector require Node >=22.22.2, not Node 18 as AGENTS.md says.

### Requests from Sarah
- **Packages** (only you edit package.json): `@inkbox/sdk` (0.7.19 worked; it needs Node 22+). Nothing else: Supabase and Anthropic are called with plain `fetch`, so `@supabase/supabase-js` and `@anthropic-ai/sdk` are not needed by `src/db` and `src/capture`.
- **Mount my routes in `server.ts`**: `createInboundEmailRoute(...)` from `src/capture`, and `createHumanRoutes(channel)` from `src/inkbox` (three paths: `/inkbox/inbound`, `/inkbox/text`, `/inkbox/imessage`). Webhook signatures are checked with `INKBOX_WEBHOOK_SECRET`; unsigned requests are accepted only when `INKBOX_DRY_RUN=1`.
- **Which chain does a reply belong to?** `HumanReply` needs a `chain_id` and the text has none. I pick the most recently alerted open chain from the Store. For a counter question, call `channel.expectCounterDecision(chain_id, negotiation_id)` when you text the human, otherwise YES/NO is treated as an unknown reply.
- **Type gaps** (no change needed unless you want them): `EventKind` has no `imessage_in`, so inbound iMessage logs as `sms_in` with `imessage:` in `outcome`. `Action` has no confidence field; LLM-extracted Actions under 0.5 confidence are logged (`outcome: "low_confidence"`) and dropped, not raised.
- **Task addresses** come from `Inkbox.createTaskAddress`, so `log_intent` should store the returned address as `task_email`. Capture finds the task from the recipient's local part (`task-demo` matches `task_demo`), so keep task ids as `[a-z0-9_]`.
- **Handles**: Proxy's identity is `proxy-agent` (`proxy` is reserved by Inkbox). Karan's phone number is needed to register the human number.

## Sarah

### Inkbox reality check (run live on 2026-10-17 with the team's admin key; script: `src/inkbox/check.mjs`)
Needs `@inkbox/sdk` (Karan: see requests below). Every snippet assumes `const inkbox = await new Inkbox({ apiKey: process.env.INKBOX_API_KEY }).ready()`.

| Feature | Works? | Notes |
|---|---|---|
| Unique address per task | **Yes, as one identity per task** | `task_demo` becomes `task-demo@inkboxmail.com`. Handles are lowercase letters, digits and hyphens only; `proxy` is reserved. |
| Plus-addressing (`name+task@`) | **No** | Mail sent to `local+tag@inkboxmail.com` never arrived in 60s. Fallbacks: one identity per task (used), or a `[task:ID]` code in the subject (capture supports it). |
| Email out and in | **Yes** | Arrives in about 5 seconds. |
| Inbound HTML (JSON-LD) | **Yes** | Webhook payload has plain text only; `identity.getMessage(id)` returns `bodyHtml`. Capture fetches it. |
| Inbound by webhook | Built, **not tested against live Inkbox** | `POST /inkbox/inbound`, signature check with `INKBOX_WEBHOOK_SECRET`. Needs a public URL and a subscription (below). Polling `iterEmails()` works today. |
| SMS out and in | **Not tested** | Number provisioned, `smsStatus: "ready"`. Needs the human's number, and the human must text `START` first. |
| iMessage | **Router exists, not tested** | Shared router number `+15555550100`; the human texts `connect @proxy-agent` first. |
| Outbound phone call | **Not tested** | Needs the human's number. `placeCall` is called in `hosted_agent` mode. |
| A2A | **Yes** | Needs each sender's **own agent-scoped key**; the admin key is rejected. Verified: Proxy client to `hotel-agent`, task arrives as `submitted`. |

Snippets:
```ts
// Unique task address
const id = await inkbox.createIdentity("task-demo");          // id.emailAddress -> task-demo@inkboxmail.com
// Send, then read with HTML
await (await inkbox.getIdentity("airline")).sendEmail({ to: [id.emailAddress], subject: "Confirmed", bodyText: "...", bodyHtml: htmlWithJsonLd });
for await (const m of id.iterEmails()) { const full = await id.getMessage(m.id); full.bodyHtml; }
// Webhook for every inbound email (first subscription on a keyless identity returns the signing secret once)
await inkbox.webhooks.subscriptions.create({ scope: "identity", identityHandle: "task-demo", url: "https://<public>/inkbox/inbound", eventTypes: ["message.received"] });
// SMS / iMessage / call
const proxy = await inkbox.getIdentity("proxy-agent");
await proxy.sendText({ to: HUMAN_PHONE, text });
await proxy.sendIMessage({ to: HUMAN_PHONE, text });
await proxy.placeCall({ toNumber: HUMAN_PHONE, mode: "hosted_agent", reason: script });
// A2A: mint a scoped key for the sender, then send to the peer's Agent Card
const { apiKey } = await inkbox.apiKeys.create({ label: "proxy-a2a", scopedIdentityId: proxy.id });
const asProxy = await new Inkbox({ apiKey }).ready();
const dir = await asProxy.a2a.organizationDirectory({ q: "hotel-agent" });
const client = await (await asProxy.getIdentity("proxy-agent")).a2aClient();
await client.send(await client.fetchCard(dir.items[0].cardUrl), { text: JSON.stringify(message) });
```

### Identities (created 2026-10-17; keys are never written here)
| Handle | Email | Phone | Role |
|---|---|---|---|
| `proxy-agent` | proxy-agent@inkboxmail.com | +15555550101 | Proxy itself: texts, iMessage, calls, support email, A2A |
| `hotel-agent` | hotel-agent@inkboxmail.com | none | Hotel merchant agent (A2A enabled) |
| `airline` | airline@inkboxmail.com | none | Airline merchant agent (A2A enabled) |
| `transfer-support` | transfer-support@inkboxmail.com | none | Transfer support desk (email) |

The human number is **not registered yet**: it needs Karan's phone number. Then run `HUMAN_PHONE=+1... node --env-file=.env src/inkbox/setup.mjs`; it sets Proxy's inbound phone filter to whitelist and allows only that number. Replies from any other number are also dropped in code.

### Review of Dhwanil's logic and expected results (Sarah, read-only; no scenarios or scoreboard exist yet, `evals/` is empty)
Read `src/logic/compare.ts` and `tests/logic/compare.test.ts` on `origin/dhwanil`. The tests use hand-written expected values, which is the right pattern. The risks below are about the scenarios and grader still to come, so the grader does not share `compare`'s blind spots.

**Rules for the ~30 scenarios and the grader**
1. Write each scenario's `expected` (mismatches, chain members, money recovered, redo) by hand from the human's request, never by running `compare`, `trace` or `plan_undo` and copying the output. Commit the expected files before the first run so they cannot drift to match results.
2. Keep the human's real request separate from the intent the agent logs. If the agent logs the wrong dates in `log_intent`, `compare` calls it clean because the intent is its only oracle. Give each scenario a `ground_truth` and score "mistake caught" against that, so a mistake made in the logged intent counts as a miss.
3. Compute money recovered from Stripe test-mode objects (refund status and amount), not from `steps` rows or an Action's `state`. Compute false "done" claims by comparing the agent's final message with ground truth.
4. Say how the naive arm decides what it notices. If it is scripted to never notice, the headline is rigged. Either run a real agent with the self-check prompt, or label the naive arm "scripted self-review" on the scoreboard.

**Blind spots in `compare` that scenarios will hit**
- **Late price change:** nothing compares a receipt amount with a quoted price, and `Intent` has no quote. Amount is flagged only when the running total crosses `budget_total`. A late price change under budget is invisible. Either mark those 2 scenarios "expected: not caught" (honest) or add a quoted price to the contract.
- **Annual vs monthly depends on words in the summary** (`annual`, `monthly`, `per year`...). Capture builds the summary from the receipt (`Pro plan (annual)`); if a SaaS receipt has no term, `compare` silently passes. Include a SaaS receipt with no term wording and one with `P1Y`/`12-month`/`yearly` in the scenarios.
- **Duplicate rule is too narrow and too broad:** it needs the same merchant, category, amount and dates with different refs. A duplicate with a different price or a shifted day is missed. Two legitimate identical purchases (two transfers, a return leg on the same day) are flagged, which would be a false alarm. Add one of each.
- **Budget sums every live Action, including `source: "stripe"` ones.** Nothing creates Stripe-sourced Actions today; if that changes, the same charge counts twice.
- **No-alarm scenarios** (3 of them) look like the shapes already in the unit tests. Add adversarial clean tasks: a refund line, a total exactly at budget with a duplicate-looking pair, a SaaS plan with no term and no must-have, a message with `$0`.
- **Same-ref resend** never reaches `compare` (capture dedupes by ref). Test it at the capture boundary, not as a `compare` scenario.

### How the pieces plug in (for wiring at 5 PM)
- `src/db`: `createStoreFromEnv()` (Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise in memory). Run `src/db/schema.sql` once in the Supabase SQL editor; the `events` table rejects updates and deletes with a trigger.
- `src/capture`: `createCapture({ store, hooks, clock, llm? })`; routes: `createInboundEmailRoute({ capture, fetchFullMessage })` at `POST /inkbox/inbound`. Mock merchants can use `deliverToCapture(capture)` as their `deliver`.
- `src/inkbox`: `createInkbox()` implements `Inkbox` (`INKBOX_DRY_RUN=1` logs instead of sending). `createHumanChannel(...)` plus `createHumanRoutes(channel)` give `POST /inkbox/text` and `POST /inkbox/imessage`. `composeChainAlert(...)` builds the one text per chain.
- `src/web`: `createWebRoutes({ store, clock, channel, humanNumber, controls: process.env.PROXY_DEMO_ROUTES === "1" })` gives `GET /web` (the page), `GET /web/state` and `POST /web/reply` (UNDO ALL / PICK / KEEP buttons; they go through the same human channel as a text, so they are idempotent and respect the window). `store` must be `createStoreFromEnv()` or `createMemoryStore()` because the feed needs `recentEvents`. The scoreboard panel shows whatever JSON `scoreboard()` returns; Dhwanil, give me the results file path and format when it exists.
- Tests: `npm test`.

## Dhwanil

### Refunds: merchants must not refund (double-refund risk)
- The orchestrator refunds every action exactly once, through `refundOnce` in `src/orchestrator/refunds.ts`: one idempotency key per action (`refund:<action_id>`), and no refund if Stripe already shows one.
- On your branch the transfer company "refunds through Stripe when it approves". Together with the orchestrator, that would refund twice. When it approves, reply `REFUND APPROVED` with the amount and let the orchestrator issue the refund. Remove `refund` from `MerchantDeps`, or leave it unused.

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
- Done: `npm run demo:reset` (src/agent/reset.ts), `npm run demo:rehearse` (src/agent/rehearse.ts) and `npm run demo:offline` (src/agent/scripted.ts --offline), all through tsx.

### Scripted demo: end the agent's session before the late confirmations
- Team rule: the agent may only self-undo free, full-refund, self-serve actions during its session. In the scripted demo the whole chain must go to the human.
- In `src/agent/` scripted mode: after the agent calls `review` and says it is done, call `POST /demo/end-session?task_id=<task_id>` (server started with `PROXY_DEMO_ROUTES=1`), then send the late confirmations.
- Sessions also end on their own after `SESSION_IDLE_MS` without a tool call for the task.
