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

### From Dhwanil: what's on branch `dhwanil/logic-merchants`, and what I need
Built and tested (136 tests): `src/logic/` (`compare`, `trace`, `reversibility`, `rank`) and `src/merchants/` (airline, hotel with agent, transfer company, plus `RouteHandler`s). Not started: `plan_undo`, `negotiate_step`, the other two merchants, evals.

Mounting the merchants in `server.ts`:
- `import { createMerchants, merchantRoutes } from "./merchants/index.js"`, then `merchantRoutes(createMerchants(deps), deps, clock)` returns `RouteHandler[]`. Every path starts with `/merchants/`.
- `deps` is `MerchantDeps` from `src/merchants/deps.ts`: `charge({ amount, merchant, task_id, ref, description, idempotency_key }) -> { charge_id }`, `refund(charge_id, amount, idempotency_key) -> { refund_id }` (same as `Payments.refund`), and `deliver(email)` (Sarah). `createFakeDeps()` is an in-memory version for tests and local dev.
- Routes: `GET /merchants`; `POST /merchants/<id>/book`, `/confirm`, `/cancel`; `POST /merchants/hotel/agent` (answers one Proxy protocol message); `POST /merchants/transfer/support` (`{ from, subject, body }`).
- The airline has no agent: it cancels itself under the 24-hour rule on the clock you pass in. docs/04 and docs/05 still say the airline has an agent.

Needed from Karan (types.ts and package.json are yours):
1. **`npm test` skips `tests/`.** It runs `vitest run src/orchestrator`. Please change it to `vitest run`, or add `"test:logic": "vitest run tests"`. Also `src/stripe/stripe.test.ts` currently has no tests, so plain `vitest run` fails that suite.
2. **`Payments` has no `charge()`.** The merchants need one. Either add it to `Payments` with the signature above, or wire `MerchantDeps.charge` straight to Stripe.
3. **`Mismatch` needs more.** The brief wants wrong quantity, unexpected subscription and off-task, but `MismatchField` is only `dates | amount | term | item | duplicate`, `Action` has no quantity or recurring field, and `Mismatch` has no `evidence`. Add fields (for example `"quantity" | "recurring" | "scope"` and an optional `evidence: string`), or tell me to reuse `item` and `amount`. Needed before the 2:30 PM freeze.
4. **Domain grace period and final-sale items.** `ActionCategory` has no `domain` or final-sale category. Add one, or tell me to key the rules table by merchant type.
5. **Who writes `plan_undo` and `negotiate_step`?** `Logic` lists both for me, but the brief puts the protocol state machine in the orchestrator. Tell me which you want me to write.
6. **Prompt-injection merchant.** `CounterMsg` and `DenyMsg` have no free-text field except `DenyMsg.reason`. I'll put the injected text ("send the card number") in `reason`, so the orchestrator must treat everything but the typed fields as untrusted data.
7. **`must_haves` convention that `compare` reads.** `log_intent` should pass these through unchanged: `term:monthly` or `term:annual` (SaaS), and `item:`, `size:`, `model:`, `color:`, `plan:` entries (store and SaaS). Free-text must-haves are ignored.
8. **Hotel behaviors for evals.** `createMerchants(deps, { hotel: { behavior: "credit_then_partial" | "accept_full" | "deny", partial_refund_pct } })`. The default is the demo: store credit, then 85% after one push back.

### From Dhwanil: review of main, items 1 to 3 (refunds, "verified" and error handling)
Found while reviewing `origin/main`. File and line references are the current ones. These three are the ones I'd cover before wiring the real logic. I checked that the files are unchanged since my review.

**1. The self-serve route can double-refund or get stuck** (`src/orchestrator/routes/self-serve.ts:44-61`)
- My merchants used to refund inside `selfServeCancel`, and the route then refunded again. I'm removing that on my side now. Merchants will return `refund_amount` only, with `stripe_refund_id: null`. Keep the orchestrator as the only thing that refunds.
- No error handling around the Stripe calls. If `findChargeForAction` (line 49) or `payments.refund` (line 55) throws after the merchant cancelled, the action stays `requested` and no `Step` is written. Then a retry calls `selfServeCancel` again. The route should catch, write a `Step` with the error, and leave the action retryable (not `failed`) when the merchant cancel already succeeded.
- I'm making `selfServeCancel` idempotent: a repeat for an already-cancelled booking returns the same `ok: true` and `refund_amount`, so a retry works.
- `findChargeForActionId` (`src/stripe/verify.ts:37-44`) uses Stripe's PaymentIntent search, which is eventually consistent. Right after a charge it can return null, giving "no Stripe charge found". Suggest storing the charge id on the Action when `createTestCharge` returns it and reading it from the Store, with the search only as a fallback.

**2. "Verified" proves less than it claims**
- `self-serve.ts:55-61` refunds and verifies against the merchant's `cancel.refund_amount`, not the amount owed. A merchant returning 100 on a 41200 charge would end up `verified`. Self-undo is defined as free and a full refund, so require `cancel.refund_amount === action.amount` (otherwise it goes to the human), and verify against `action.amount`.
- `verifyRefundAmount` (`src/stripe/verify.ts:77,83`) accepts an amount of 0: `refundedAmount >= 0` is always true, so it reports `verified` with no refund. Reject `amount <= 0`. My hotel returns `refund_amount: 0` when Proxy accepts store credit, so this case is real.
- `verifyRefund(actionId)` (`verify.ts:59-69`) returns true for any succeeded refund of any size. It's exported. Remove it or make it amount-aware.
- The refund idempotency key `refund:${action_id}` fails at Stripe if a retry has a different amount. Include the amount in the key, or handle the error.

**3. Internal errors reach the agent and are marked retryable** (`src/tools/result.ts:46`)
- `fail("internal", e.message, true, "retry")` returns the raw error message to the agent and tells it to retry every time. Stripe error text can include a masked key fragment, and the docs promise tokens and codes never reach the agent.
- Return a generic message, log the detail server-side with context (tool, task_id, error name), and set `retryable: true` only for known transient errors (`StripeApiError` 429 or 5xx, `upstream_unavailable`).

## Sarah

### From Dhwanil: merchant confirmation emails and the support desk
- Each merchant calls `deps.deliver(email)` with a `MerchantEmail`: `to` is the task address, plus `from`, `subject`, plain-text `body` and `html`. You implement `deliver` (Inkbox send, or post straight to the capture webhook in dev).
- The `html` carries schema.org JSON-LD in `<script type="application/ld+json">`. Parse that first. The `@type` is `FlightReservation`, `LodgingReservation` or `TaxiReservation`.
- Fields to read: `reservationNumber` (the ref, which becomes `Action.ref`); `totalPrice` is a dollar string like `"412.00"`, so convert to cents with `Math.round(parseFloat(x) * 100)`; `priceCurrency` is `USD`; flights have `reservationFor.departureTime` and `arrivalTime` (ISO with offset); hotels have `checkinTime` and `checkoutTime`; transfers have `pickupTime`. `Action.dates` comes from the date part of those times.
- Booking confirmations go out at booking time, unless the booking used `defer_confirmation` (the scripted demo uses this for the late hotel confirmation). `POST /merchants/<id>/confirm { ref }` sends it later.
- The transfer company has no agent. Proxy emails `support@metrotransfer.example` with the booking ref (`TRF-XXXXXX`) in the subject or body. In dev, route that email to `POST /merchants/transfer/support { from, subject, body }`. It replies through `deliver` with `REFUND APPROVED` or `REFUND DENIED` in the body, and refunds through Stripe when it approves.
- My tests use `task-nyc@inbox.proxy.example`. I'll switch once the real task address format is settled.

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
### Status from Dhwanil
Branch `dhwanil`. Done: `compare`, `trace`, `reversibility`, `rank`, the rules table, and the airline, hotel and transfer merchants with routes. Building next, in order: `plan_undo` (4-argument form, see Contract v2), `negotiate_step`, the host correction merchant, demo fixtures, then the scenario runner with the naive arm. Also changing: `compare` fills `Mismatch.evidence`, and the merchants stop refunding (they return `refund_amount`; the orchestrator refunds through `Payments`).

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
