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

### Public URL for Inkbox webhooks (until the Manufact deploy is up)
Inkbox can't reach `localhost`, so `/inkbox/inbound`, `/inkbox/text` and `/inkbox/imessage` need a public URL.
1. **mcp-use's built-in tunnel (try first):** `npm run dev -- --tunnel`. It prints a public URL that forwards to the whole local server, webhooks included.
2. **ngrok (fallback):** run `npm run dev`, then `ngrok http 3000`, and use the `https://...ngrok...` URL it prints.
3. **Inkbox's own Tunnels API** is listed in their docs (inkbox.ai/docs/api/tunnels) but nobody has tested it. Use 1 or 2.

Then subscribe with that URL (Sarah's snippet; the first subscription on an identity returns its signing secret once, so put it in `.env` as `INKBOX_WEBHOOK_SECRET`):
- Each task identity (or `task-demo` for the demo), event `message.received`, URL `https://<public>/inkbox/inbound`.
- `proxy-agent`, event `text.received` to `https://<public>/inkbox/text`, and `imessage.received` to `https://<public>/inkbox/imessage`.

The tunnel URL changes every run, so re-subscribe after restarting it. `WEBHOOK_URL=https://<public>/inkbox/inbound node --env-file=.env src/inkbox/check.mjs` tests inbound delivery end to end. Without a tunnel, `INKBOX_DRY_RUN=1` accepts unsigned test posts to the same routes.

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

### From Dhwanil: what is built, and how to wire it
Everything below is on branch `dhwanil` with tests (329 passing) and a clean `tsc`.

**Logic.** `import { logic } from "./logic/index.js"` is a full `Logic` (all six functions, Contract v2 signatures). It replaces the stand-in.
- `compare` fills `Mismatch.evidence` (`source_action_id` and `receipt_fields`). Per your answer, wrong quantity and off-task items use `item`, an unexpected subscription uses `term`, and over budget uses `amount`.
- `trace` follows the Contract v2 root rule: the earliest booked (non-message) action.
- `plan_undo(chain, actions, preferences, now)` returns steps most urgent first. A closed window gives a fee fix only when the fee is strictly less than the money lost, otherwise `option: "keep"` with `route: "stripe_dispute"` (the last resort you may still try).
- `negotiate_step` returns `{ next_state, outgoing?, ignored_text }`. `ignored_text` is any untrusted merchant text it saw and did not act on (a deny `reason`, or extra fields): please log it. Things to know when you wire it:
  - `ask_human` is a message to the human, not to the merchant. Do not forward it to `agent.respond`.
  - Rounds are counted from `max(state.round, message.round)`, so a merchant cannot extend the 3-round limit. It never pushes back twice.
  - Store credit is not a refund. If the human allows credit and Proxy accepts it, the merchant's `accept` has `refund_amount: 0` and the state ends `failed`. Treat that as "credited" in the orchestrator, not as a failure to retry.
  - The outgoing `sent_at` echoes the merchant message's time, since the function has no clock. Stamp the real send time.

**Merchants.** `merchantRoutes(createMerchants(deps), deps, clock)` returns `RouteHandler[]`, all under `/merchants/`. `deps` is `{ charge, deliver }`; `createFakeDeps()` is an in-memory version. Merchants: `airline` (no agent, self-serve under the 24-hour rule), `hotel` (agent), `transfer` (email support), `host` (email, takes corrections, costs $0 so no charge is made). Routes: `GET /merchants`; `POST /merchants/<id>/book`, `/confirm`, `/cancel`; `POST /merchants/hotel/agent`; `POST /merchants/transfer/support` and `/merchants/host/support`. `docs/04` and `docs/05` already say the airline has no agent.

**Fixtures and evals.** `npx tsx evals/demo-fixtures.ts` regenerates `fixtures/demo/` (the demo case as schema.org emails, actions and Stripe events). `npx tsx evals/run.ts` runs the Layer 1 scenarios against both arms and saves a raw log under `evals/results/`. package.json is yours: scripts like `fixtures:demo` and `evals:layer1` would be handy.

**Still needed from Karan**
1. The review items 1 to 3 below (refund once and verify the right amount, error handling). Merchants no longer refund, which covers the double-refund half of item 1.
2. Whether `plan_undo` keeps `route: "stripe_dispute"` for `option: "keep"` steps. If you would rather have a different marker for "accept the loss", tell me and I will change it.

### From Dhwanil: merchants on real Inkbox identities (new)
Each sending identity needs its own key, and the admin key is rejected for A2A. The merchants read three separate variables from the environment and nothing else.

- **Please add to `.env.example`:** `INKBOX_AIRLINE_API_KEY`, `INKBOX_HOTEL_AGENT_API_KEY`, `INKBOX_TRANSFER_SUPPORT_API_KEY` (Sarah sends the values privately; they are never written to a file here), and `MERCHANT_ADDRESS_MODE` (unset or `test` is the default; `real` is for end-to-end runs only).
- **Addresses:** tests and every default run use the `.example` addresses, including `support@metrotransfer.example` for the transfer desk. `real` switches to `airline@inkboxmail.com`, `hotel-agent@inkboxmail.com` and `transfer-support@inkboxmail.com`, for the senders, the desks' `support_email`, and the footer text in the emails.
- **Wiring:** `createMerchants({ charge, deliver: createInkboxDeliver() }, { addresses: addressMode() })`, all exported from `src/merchants/index.ts`. `deliver` sends each email as the merchant it belongs to, with that identity's key, falling back to `INKBOX_API_KEY` when an identity's key is not set (email out works with it). An email with no merchant identity, such as the copy of the agent's message to the host, goes out as Proxy (`INKBOX_PROXY_HANDLE`, `INKBOX_PROXY_API_KEY`).
- `INKBOX_DRY_RUN=1` logs the sender, recipient and subject and sends nothing. Keys are never logged, and are removed from any error message.
- **Not tested against live Inkbox:** that needs the keys. The SDK calls are exactly the ones in Sarah's reality check.
- **`agent_identity` for the hotel is now `hotel-agent`** (the real handle), in both modes.
- **Open for Sarah or Karan: who answers the hotel's A2A tasks?** `merchants.agent("hotel").respond(message, now)` answers one Proxy message, but something has to receive A2A tasks addressed to `hotel-agent` (using the hotel-agent key) and send the reply back. I do not know the SDK calls for receiving and answering a task, only for sending, so I have not built that. Until it exists, the email fallback works through `POST /merchants/hotel/agent`.

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
- The `html` carries schema.org JSON-LD in `<script type="application/ld+json">`. Parse that first. The `@type` is `FlightReservation`, `LodgingReservation`, `TaxiReservation`, or `EmailMessage` for the host message.
- **Answer key:** `fixtures/demo/` has the real emails and the `actions.json` your extractor should produce from them. `evals/sim.ts` (`actionFromJsonLd`) is a reference extractor you can copy from. A test keeps the fixtures from going stale.
- Fields to read: `reservationNumber` is the ref (for an `EmailMessage` the ref is `identifier`); `totalPrice` is a dollar string like `"412.00"`, so convert to cents with `Math.round(parseFloat(x) * 100)`; `priceCurrency` is `USD`; flights have `reservationFor.departureTime` and `arrivalTime` (ISO with offset); hotels have `checkinTime` and `checkoutTime`; transfers have `pickupTime`; messages have `about.startDate`. `Action.dates` comes from the date part. The host message is `source: "agent"` and costs $0.
- Booking confirmations go out at booking time, unless the booking used `defer_confirmation` (the scripted demo uses this for the late hotel confirmation). `POST /merchants/<id>/confirm { ref }` sends it later.
- Two merchants take email: the transfer company (`support@metrotransfer.example`, refs `TRF-XXXXXX`) and the host (`alex.rivera@example.com`, refs `MSG-XXXXXX`). Put the ref in the subject or body. In dev, route the email to `POST /merchants/transfer/support` or `POST /merchants/host/support` with `{ from, subject, body }`. The reply goes out through `deliver`. The transfer company says `REFUND APPROVED` or `REFUND DENIED` and agrees an amount; it does not refund. The host acknowledges a correction and agrees $0.
- Tests use `task_nyc@tasks.proxy.example`.
- **Scoreboard results (your question):** `npx tsx evals/run.ts` writes `evals/results/<run_id>.json`, for example `evals/results/layer1-2026-10-17T22-02-56-922Z.json`. Shape: `{ run_id, layer: "scripted", note, summaries: [{ arm, scenarios, passed, mistakes_expected, mistakes_caught, false_alarms, chain_members_expected, chain_members_found, outcomes_expected, outcomes_correct, refund_agreed, refund_expected, false_done_claims }], grades: Grade[], results: RunResult[] }`, with the types in `evals/scenario.ts`. `summaries` is one object per arm (`naive`, `proxy`). Money is in cents. The naive arm is a scripted self-review, and the `note` says so. I will keep this shape. I read your review: ground truth separate from the logged intent, known misses, and the extra adversarial scenarios are my next changes.
### Requests from Sarah
- **Packages** (only you edit package.json): `@inkbox/sdk` (0.7.19 worked; it needs Node 22+). Nothing else: Supabase and Anthropic are called with plain `fetch`, so `@supabase/supabase-js` and `@anthropic-ai/sdk` are not needed by `src/db` and `src/capture`.
- **Mount my routes in `server.ts`**: `createInboundEmailRoute(...)` from `src/capture`, and `createHumanRoutes(channel)` from `src/inkbox` (three paths: `/inkbox/inbound`, `/inkbox/text`, `/inkbox/imessage`). Webhook signatures are checked with `INKBOX_WEBHOOK_SECRET`; unsigned requests are accepted only when `INKBOX_DRY_RUN=1`.
- **Which chain does a reply belong to?** `HumanReply` needs a `chain_id` and the text has none. I pick the most recently alerted open chain from the Store. For a counter question, call `channel.expectCounterDecision(chain_id, negotiation_id)` when you text the human, otherwise YES/NO is treated as an unknown reply.
- **Type gaps** (no change needed unless you want them): `EventKind` has no `imessage_in`, so inbound iMessage logs as `sms_in` with `imessage:` in `outcome`. `Action` has no confidence field; LLM-extracted Actions under 0.5 confidence are logged (`outcome: "low_confidence"`) and dropped, not raised.
- **Task addresses** come from `Inkbox.createTaskAddress`, so `log_intent` should store the returned address as `task_email`. Capture finds the task from the recipient's local part (`task-demo` matches `task_demo`), so keep task ids as `[a-z0-9_]`.
- **Handles**: Proxy's identity is `proxy-agent` (`proxy` is reserved by Inkbox). Karan's phone number is needed to register the human number.

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

### From Dhwanil: scenarios ready for your review (Sarah)
`evals/scenarios.ts` has 34 scenarios. Every expected result is written by hand from the story and the human's real request, not copied from what the logic outputs. Please check them the way you offered, so the grader does not share `compare`'s blind spots. Run `npx tsx evals/run.ts` to see them against both arms and `evals/results/` for the raw log.

What I did with your earlier points:
- **Ground truth vs the logged intent:** a scenario has `intent` (what the human really asked) and an optional `logged_intent` (what the agent logged). Proxy compares against the logged one. S34 is the case where they differ: all four wrong bookings are counted as real mistakes that Proxy misses.
- **Known misses and known false alarms are documented, and fail loudly if they stop being true.** S15 (price rose after the quote, still under budget: no quote to compare against), S34 (wrong logged intent), S33 (two real identical transfers look like a duplicate). They count in the totals: 44 real mistakes, 39 caught, 5 documented misses, 1 documented false alarm.
- **The naive arm is labelled "scripted self-review"** in the CLI output and the raw log. What it notices follows each scenario's `assumption`, so those numbers are not a measured rate. Please look hard at the `assumption` lines: they are the soft spot.
- **Your blind-spot list:** term wording now includes `P1Y`, `P12M`, `/yr`, `/mo`; a charge seen by both email and Stripe is counted once; `item:` and `size:` match whole words (`size:M` no longer matches "Medium"). Not done: the quoted-price gap (S15 documents it), and the two-identical-purchases false alarm (S33 documents it).
- **Adversarial clean tasks:** S29 (total exactly at budget), S31 (SaaS receipt with no term), S32 (a $0 message), S28 (late confirmation). I did not add a refund line, because `Action.amount` has no negative case.
- Money here is what the merchants agreed. Verifying it against Stripe test-mode objects, as you asked, happens in Layer 2 and the orchestrator, not in Layer 1.

### How the pieces plug in (for wiring at 5 PM)
- `src/db`: `createStoreFromEnv()` (Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise in memory). Run `src/db/schema.sql` once in the Supabase SQL editor; the `events` table rejects updates and deletes with a trigger.
- `src/capture`: `createCapture({ store, hooks, clock, llm? })`; routes: `createInboundEmailRoute({ capture, fetchFullMessage })` at `POST /inkbox/inbound`. Mock merchants can use `deliverToCapture(capture)` as their `deliver`.
- `src/inkbox`: `createInkbox()` implements `Inkbox` (`INKBOX_DRY_RUN=1` logs instead of sending). `createHumanChannel(...)` plus `createHumanRoutes(channel)` give `POST /inkbox/text` and `POST /inkbox/imessage`. `composeChainAlert(...)` builds the one text per chain.
- `src/web`: `createWebRoutes({ store, clock, channel, humanNumber, controls: process.env.PROXY_DEMO_ROUTES === "1" })` gives `GET /web` (the page), `GET /web/state` and `POST /web/reply` (UNDO ALL / PICK / KEEP buttons; they go through the same human channel as a text, so they are idempotent and respect the window). `store` must be `createStoreFromEnv()` or `createMemoryStore()` because the feed needs `recentEvents`. The scoreboard panel shows whatever JSON `scoreboard()` returns; Dhwanil, give me the results file path and format when it exists.
- Tests: `npm test`.

## Dhwanil

### Refunds: done
Merchants no longer refund. `selfServeCancel`, the hotel agent and the support desks only agree an amount and return it; the orchestrator refunds and verifies through `Payments`. `MerchantDeps` is now `{ charge, deliver }`. Cancelling again, or emailing a desk again, returns the same agreed refund, so an orchestrator retry works.

### A2A: the hotel agent must send with its own key
- Inkbox A2A needs a separate API key for each sending identity, and it rejects the admin key (`INKBOX_API_KEY`). So the hotel agent must send its `accept` / `counter` / `deny` replies with the `hotel-agent` identity's own agent-scoped key, never the admin key.
- Sarah creates the per-identity keys (`inkbox.apiKeys.create({ label, scopedIdentityId })`). Ask her for the `hotel-agent` key, read it from an env variable (e.g. `INKBOX_HOTEL_AGENT_API_KEY`), and ask Karan under "Karan" to add the name to `.env.example`. Never commit or log the key.
- **Dhwanil, done on my side:** the merchants read `INKBOX_AIRLINE_API_KEY`, `INKBOX_HOTEL_AGENT_API_KEY` and `INKBOX_TRANSFER_SUPPORT_API_KEY`, and `createInkboxDeliver` sends each email as the right identity with its own key (see "merchants on real Inkbox identities" under Karan). Still open: something has to receive A2A tasks sent to `hotel-agent` and call `merchants.agent("hotel").respond`.

### Refunds: merchants must not refund (done: see "Refunds: done" above)
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
Branch `dhwanil`. Done, with tests: all six `Logic` functions in `src/logic/`; the airline, hotel agent, transfer company, host, SaaS vendor and store merchants with `RouteHandler`s; the demo fixtures in `fixtures/demo/`; and the Layer 1 scenario runner, grader and CLI in `evals/` with **34 scenarios** (`evals/scenarios.ts`) and a scripted-self-review naive arm. Not started: Layer 2 (live agent, needs the Anthropic key), the scoreboard page, time-to-alert and tokens metrics, and a live Inkbox run of the merchants (needs the keys). Waiting on Sarah's review of the expected results.

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
