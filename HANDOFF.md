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
11. **`EvidencePacket.message_timeline` is optional** and contains `{ at, channel, direction, summary }` entries, so dispute evidence can carry the communication audit trail without a Stripe-local type extension. (Karan's Codex)
- **Sarah, item 3: done.** The human channel forwards STOP as `{ kind: "stop" }` (no reply over SMS, where the carrier answers; a short "paused" reply over iMessage) and a loose reply as `{ kind: "correction", chain_id, corrected_text }` with the words unchanged and no reply of its own. START, UNSTOP and HELP are carrier keywords and are ignored. A bare YES or NO with no question open still gets one "I'm not sure what you're answering".


## Karan

### From Dhwanil: the store story ("The wrong charger") and what it changed in your area (2026-10-18)
- **Story:** the agent orders a USB-A 20W charger from Northwind Market (fictional) instead of USB-C 65W. Proxy flags the item, the human replies UNDO ALL, Northwind's support agent offers store credit, Proxy pushes back (no_store_credit), the agent denies and points to its return form, Proxy fills the form field by field, gets an RMA and a label with a QR code (a real, scannable one), texts "Your return label is ready. Drop it off by …", the simulated carrier scans the drop-off, the refund is verified, and the agent reorders the USB-C 65W charger ($52). It runs on `/web/show?scenario=store`, in the story picker, and with `npm run demo:go -- --scenario store`.
- **Live server:** Northwind is `in_process` (it has no Inkbox identity). Its agent always answers by loopback, its emails go straight to capture even with `MERCHANT_ADDRESS_MODE=real`, and its handle is not trusted by the protocol inbox. The human's alert and reply still use real Inkbox. The page labels it "Simulated store". Covered by `tests/stories/store-live.test.ts`.
- **Your files, all additive:** `undo.ts` (the deny branch hands over to the new `return-flow.ts` when the merchant has a return form; `onCarrierScan`; `refundAndVerify(…, how?)`; `requestFor` uses the item mismatch), `feed.ts` (kinds `form_field`, `return_label`, `carrier_scan`; actors `store`, `carrier`), `copy.ts` (item wording), `proxy.ts` (store booking and redo lines, `item` in the booking data), `runtime.ts` (simulated carrier `PROXY_CARRIER_SCAN_MS`, default 4 s, moves a simulated clock forward a day; Northwind sender mapping for capture; store redo in `demoRedo`; per-merchant loopback), `sandbox.ts` (`store` scenario, starts Oct 10), `src/web/show.ts` (story, scenes, form, label, tracking and receipt cards), `src/agent/scenarios.ts` and `scripts/demo-go.ts` (`runStoreAgent`). Your pacing, the who/how copy and the visible self-undo are unchanged.
- **Known:** the plan chip at the top of "Behind the scenes" still reads "Negotiate with Northwind Market's agent…" while Proxy fills the form; it turns to "$45 back" at the end.

### Proxy asks before accepting any merchant offer (2026-10-18)
- At the merchant's final position (where `negotiate_step` would accept, or hands the decision over) Proxy pauses the negotiation and texts the human every distinct offer, numbered, with its recommendation from their rules: "Harborview Hotel's best offer: 1) Refund $544 (85%) to your card 2) $640 store credit at Harborview Hotel. Your rules prefer refunds, so I recommend 1. Reply 1 or 2." KEEP PUSHING is offered when a round is left to push and still accept.
- Reply 1 / 2 sends `accept_counter` naming the chosen offer (`counter` field). A refund is refunded and verified as before; store credit is kept as credit (`PlanStep.credit_amount`, action `kept`), never counted as money back ("$600 of $1,240 back, plus $640 as store credit"). YES takes the recommendation, NO declines.
- While the human decides, no merchant timer runs and no round is used; one reminder after `COUNTER_REMIND_MS` (60 s in demo mode, 30 min otherwise; `PROXY_COUNTER_REMIND_MS`). Proxy never accepts silently.
- demo:rehearse and try_proxy_demo answer 1 automatically.

### Showcase order for the live demo (2026-10-18)
- In demo mode (`PROXY_DEMO_ROUTES=1`, pacing on) Proxy undoes one merchant at a time, in showcase order: the hotel negotiation first, then support emails, then the host correction. Each step waits until the previous one settles (bounded by the negotiation's own timeouts). Outside demo mode steps still run side by side. `PROXY_DEMO_SEQUENTIAL=1` forces it with pacing off (the sandbox recordings use this).
- After UNDO ALL the feed gets Proxy's plan (`kind: "plan"`); /web/show shows it as a row of steps under the Recovered total: the agent's own fix, then each merchant (current one highlighted, then green with the amount back).

### Demo clarity and pacing (2026-10-18)
- `DEMO_PACE_MS` (demo mode only, `PROXY_DEMO_ROUTES=1`; default 2500, 0 in tests and in sandboxes): visible pauses with "waiting for a reply…" and "verifying in Stripe…" lines around each support email, refund and host correction, and about 2 s between hotel negotiation messages. Outside demo mode nothing is slowed. Set `DEMO_PACE_MS=1000` to speed up or `4000` to slow down.
- The alert now reads "Your agent already fixed the flight ($412). 3 more things need you." Every refund text says who did it and how ("Proxy negotiated with the hotel's agent. Hotel refunded, $544 of $640, confirmed in Stripe."), and so does every refund row and receipt on /web/show. The agent's own flight undo is its own message in "Your agent".
- Before the human replies, only the agent's own self-undo happens (tested in workflow 17).

### Readiness and the intent check (2026-10-17)
- Tag `demo-v2` is on main at 51feb13 (`demo-v1` unchanged).
- Every tool parameter has a description; `src/tools/schemas.test.ts` fails if one is added without.
- `undo` with an unknown action id returns `not_found` (`next_action: "fix_now"`, "call review(task_id), then undo with those ids") and undoes nothing.
- Intent check: numeric and day-only dates, the ambiguous "3/11" question, and "nothing checkable" (see the note under Dhwanil).

### Cloud judge copy: PROXY_MODE=cloud, try_proxy_demo, /health (2026-10-18)
- **Set on the deployed server:** `PROXY_MODE=cloud` and `PROXY_DEMO_ROUTES=1` (the second makes `try_proxy_demo` available; cloud mode makes it safe). Keep `INKBOX_DRY_RUN=1` too; no keys are needed, and none have any effect in cloud mode.
- **Cloud mode:** in-memory store, simulated payments ("Stripe (simulated)" in every text), a stand-in Inkbox that sends nothing, no model calls, no human number. The Inkbox webhook routes, the mock merchants' endpoints, `/web/reply` and every mutating `/demo/*` route (including `/demo/reset`) return 404; `/demo/feed`, `/web/stage`, `/web/state`, `/scoreboard` and `/health` work. No poller starts.
- **`try_proxy_demo`** (7th tool, only with cloud mode or demo routes) runs the whole story in its own isolated runtime with task id `sandbox_<random>`: wrong-date bookings, the agent's own flight undo, late confirmations, the alert, a simulated UNDO ALL, the hotel negotiation (store credit, push back, 85%), refunds, the host correction and the redo. It returns in about a second with `chain_id`, a plain-English summary and "call get_chain with this chain_id to see the result". `get_chain`, `review` and `list_chains` find sandbox chains; `list_chains` lists sandbox chains whatever their state. At most 40 runs are kept (the oldest go first), 8 at once.
- **Boot example:** with cloud mode, startup creates one finished chain, `sandbox_example`, so `list_chains` and `get_chain` have data after any restart. `/web/stage` and `/demo/feed` default to it.
- **`/status`** (and `/health` on a local server) returns `{ ok, commit, mode, sandbox, services }`: the short git SHA baked in by `scripts/write-build-info.ts` (it runs before `build`, `dev`, `preview` and `start` through the npm `pre` hooks; set `PROXY_COMMIT=<sha>` if the deploy builds without them and without `.git`), `cloud`, `demo` or `live`, and for each service `OK`, `not configured` or `disabled (cloud mode)`. Never a value. **On Manufact Cloud the gateway answers `/health` itself (`{"status":"healthy"}`), so check `https://<slug>.run.mcp-use.com/status` instead.** A deploy from `git archive` has no `.git`, so put the commit in before uploading: `echo "export const BUILD_COMMIT: string = \"$(git rev-parse --short=7 origin/main)\";" > /tmp/proxy-deploy/src/build-info.ts` (the build keeps it), or set `PROXY_COMMIT=<sha>` on the server. After a deploy, check that `commit` there is the one you pushed.
- Every tool now answers in plain English first (with the next step) and the JSON second, so clients without structured output or MCP Apps still get the answer.

### Public mirror for judges: karan6705/proxy (2026-10-18)
- The team repo (karan6705/tripwire) stays private and is never rewritten. Judges get **https://github.com/karan6705/proxy**: the same history, `main` only (plus the `demo-v1` and `demo-v2` tags), with three phone numbers replaced everywhere in history by fictional ones (the two Inkbox lines and Karan's personal number, which were in early HANDOFF.md and test commits). Commit dates, authors and messages are unchanged.
- **Refresh it right before submitting:** `scripts/publish-mirror.sh` (needs `git filter-repo` and `gh`). It clones main fresh into a temp folder, redacts, runs `scripts/secret-scan.py` on the result (no push unless it is clean), checks dates, authors and messages, then force-pushes to the mirror only. `scripts/publish-mirror.sh --dry-run` does everything but the push.
- `python3 -I scripts/secret-scan.py <repo>` scans every ref's history for keys, tokens and real-looking phone numbers (with `HUMAN_PHONE` in the environment, that number too) and prints commit, file and kind only, never a value.
- Never put a real phone number in a file, test or log. Use 555 numbers (`+15555550100`), as the tests do.

### QA pass on the live demo (2026-10-18)
- `npm run demo:hotel` stays up until Ctrl+C, names any missing variable, logs each answer, and picks up requests from the last 30 minutes.
- Undo steps run side by side. A merchant agent that is slow or hangs blocks nothing: after `MERCHANT_REPLY_TIMEOUT` (60 s in the demo, `PROXY_AGENT_TIMEOUT_MS`) Proxy texts "The hotel hasn't answered, following up by email" and resends the request by email. After a second timeout it tells the human, and the summary names the next option.
- One text per confirmed step, then one summary. All texts come from `src/orchestrator/copy.ts`.
- The 16 workflows are tests in `src/orchestrator/workflows.test.ts`.

### Status: UNDO ALL runs end to end (2026-10-17)
- `src/orchestrator/undo.ts` runs a chain after UNDO ALL or PICK: plan from `plan_undo`, then self-serve (flight), Reversal Protocol (hotel: request, store-credit counter, push back, 85% counter, accept_counter, accept, refund, verify), support email (transfer), and a correction email (host). The chain ends `redo_requested`, and `get_chain` returns the redo instruction.
- One text per chain, by iMessage (`HUMAN_ALERT_CHANNEL=sms` switches it), sent 1.5 s after the last late confirmation (`PROXY_ALERT_SETTLE_MS`). Without `HUMAN_PHONE`, the alert is recorded but not sent, and the `/web` page buttons reply as the human (demo only).
- Refunds are verified against the agreed amount (`PlanStep.refund_amount`, the accepted counter), not the booking price. The widget's recovered total uses what Stripe shows.
- Protocol transport: real Inkbox when `INKBOX_API_KEY` is set and `INKBOX_DRY_RUN` isn't; otherwise the in-process mock agent answers (`PROXY_PROTOCOL_LOOPBACK=1/0` forces either). Real mode starts Sarah's protocol inbox once; for the hotel side run `npm run demo:hotel` next to the server.
- Not built yet: support-email follow-ups and calls, Stripe disputes for `keep` steps, auto-undo, confirming a free-text correction with the human.

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

### From Dhwanil: demo polish for the agent-to-agent part (2026-10-18)
Done on branch `dhwanil` (PR to follow):
- **Hotel persona.** Every hotel counter and accept now carries a short plain-language `message` next to the typed fields (for example "Rate is non-refundable. We can offer store credit of $640.00." and "As a one-time goodwill exception we can refund 85%, $544.00."). `negotiate_step` reads only the typed fields and returns the line in `ignored_text` like any other merchant text.
- **Narration helpers** in `src/merchants/narrate.ts`, exported from `src/merchants/index.js`: `narrateExchange(incoming, reply, { color })` returns the two lines for one exchange (`← Proxy: reversal request for HTL-..., wrong dates`, `→ Proxy: ...`), `narrateSupport(email, reply)` does the same for the transfer desk's email replies, `colorEnabled()` honours `NO_COLOR` and pipes, and every line is cut to one short line with control characters removed.
- **Scoreboard page** in `evals/scoreboard.ts`: `npx tsx evals/scoreboard.ts` writes `evals/scoreboard/index.html`, a self-contained dark 16:9 slide with counts only and the caveat line.
- **`plan_undo`, airline after 24 hours: NOT changed yet, waiting on you.** Your QA item 1 asks for something Proxy can do or `keep`. `keep` is right (the airline has no agent and no support desk), and I have the change ready: in `src/logic/plan-undo.ts`, the fee-fix branch returns `keep(action)` when `action.merchant === "airline"` (a 3-line change, tests included). I held it out of this PR because it makes your `src/orchestrator/workflows.test.ts` test 10 fail: with a `keep` step the final text becomes "All done. $0 of $412 back", but the flight is still open. Your final-text code should list `keep` steps under "Still open", for the airline with the fee: "Flight (change it with the airline for a $75 fee)", which `reversibility` still gives you (`kind: "change"`, `cost_to_reverse: 7500`). Tell me once test 10 and that text are ready (or that I should push my change and you fix them) and I will push it the same hour.

Requests for you (the files are yours):
1. **`scripts/hotel-agent.ts`** (for `npm run demo:hotel`): in `respond(message)`, after you get the reply from the route, print the exchange:
   ```ts
   import { colorEnabled, narrateExchange } from "../src/merchants/index.js";
   // inside respond(), after `const reply = (await res.json()) as MerchantProtocolMessage;`
   for (const line of narrateExchange(message, reply, { color: colorEnabled() })) console.log(line);
   return reply;
   ```
   Add `FORCE_COLOR=1` to the command if the terminal is not detected as a TTY when you record.
2. **Serve the scoreboard at `/scoreboard`:** `import { renderLatestScoreboard } from "../evals/scoreboard.js"` and return it as `text/html` (it reads the newest `evals/results/layer1-*.json` and `layer2-*.json`). If you would rather not import from `evals/`, serve the file `evals/scoreboard/index.html`; run `npx tsx evals/scoreboard.ts` first to refresh it.
3. **"keep" route:** `RouteKind` has no `keep` yet (only `FixOption` does). `plan_undo` still marks keep steps with `route: "stripe_dispute"`. Tell me when `"keep"` is in `RouteKind` and I will switch; it is a one-line change in `src/logic/plan-undo.ts` plus tests.
4. **The transfer desk's lines on the server terminal:** `narrateSupport(email, reply)` returns `{ received, replied }`; call it where you handle `POST /merchants/transfer/support` if you want them printed there.

### From Dhwanil: review of the demo feed's agent-to-agent lines (for the video)
Test applied: would someone who has never seen the protocol follow it without a voice-over? Today, no. I read what a viewer sees on the `/web` feed (`src/web/page.ts`, one row per event: a pill with `e.kind`, then `tool_name: outcome`) and the step messages the orchestrator writes (`src/orchestrator/undo.ts`).

**What the feed shows now**
```
a2a         out:request_reversal
a2a         out:push_back
a2a         out:accept_counter
a2a         ignored_text:1
email_out   support_request
email_out   follow_up:counter
email_out   correction
```
and step messages: `Asked the merchant agent to reverse the booking`, `Merchant counter $640.00; now countered`, `Received counter [in:2026-10-18T...|counter:1:64000]`, `Merchant agreed $544.00`.

**Problems**
1. **Jargon.** `a2a`, `out:`, `reversal_protocol`, `countered`, `refund_pending` and `ignored_text:1` mean nothing to a viewer. `ignored_text:1` reads like an error; it is actually the safety story (Proxy never acts on a merchant's free text).
2. **Only Proxy's side is in the feed.** Nothing says who it is talking to, and the merchant's answers (counter $640 store credit, counter $544, accept) are missing from the event feed, so the negotiation looks one-sided. The amounts and the 85% never appear.
3. **The request text contains raw JSON.** `what_went_wrong` is `Booked <item>; the task needed {"start":"2026-11-13","end":"2026-11-16"}.` (`undo.ts` line 215). It also shows on the hotel's terminal.
4. **An internal marker is in a step message:** `Received counter [in:<time>|counter:1:64000]`. Keep the marker, but not in the text anyone reads.
5. **Arrows are ambiguous.** `→ Proxy: offering store credit` reads as if Proxy is the speaker. Label lines by who is talking.

**Suggested wording** (event, then the line to show). Names come from the merchant; amounts from the message:
| Event | Show |
|---|---|
| `a2a out:request_reversal` | Proxy asks the hotel to reverse the booking: it was booked for Nov 3, the customer needs Nov 13 |
| (new) `a2a in:counter store_credit` | Hotel offers store credit, $640 |
| `a2a out:push_back` | Proxy pushes back: the customer wants the money back, not store credit |
| (new) `a2a in:counter partial_refund` | Hotel offers a refund of $544 (85%) |
| `a2a out:accept_counter` | Proxy accepts the $544 refund |
| (new) `a2a in:accept` | Hotel confirms: $544 refund agreed |
| `a2a ignored_text:N` | The hotel added free text. Proxy never acts on a merchant's text, so it was ignored |
| `email_out support_request` | Proxy emails Metro Transfer support to cancel the transfer |
| `email_out follow_up:...` | No reply yet: Proxy follows up with Metro Transfer |
| `email_out correction` | Proxy emails the host: the correct arrival date is Nov 13 |
| `what_went_wrong` | Booked Nov 3 to Nov 6, but the customer needs Nov 13 to Nov 16. |
Pills: show the merchant (Hotel, Transfer, Host) and a plain icon or word for the channel, not `a2a` and `email_out`.

**What I changed on my side:** the push-back reasons (mine, in `negotiate_step`) now read "The customer does not accept store credit. Please refund the original payment." and "That refund is below the minimum the customer accepts. Please improve the offer." And `narrateExchange(..., { style: "speakers", merchant: "Hotel" })` prints `Proxy: ...` and `Hotel: ...` instead of arrows. Use `style: "speakers"` in `scripts/hotel-agent.ts` for the video; arrows stay the default.

### From Dhwanil: the intent check, measured (2026-10-18)
I reran only the two misread tasks (C1 stale calendar, C2 "3/11") with the agent passing the human's words as `original_request`: **Proxy caught 0 of 18** (3 trials per arm; `evals/results/intentcheck-2026-10-18T02-37-52-316Z.json`, written up in `evals/RESULTS.md`). The agent passed the words in 6 of 6 runs; `checkIntent` said "agrees" in 6 of 6 because it had nothing it could read: C1's words contain no date ("it's on my calendar"), and C2 writes "3/11", which the parser does not read. The same check does catch "November 13" against a logged Nov 3 (`tests/evals/live-intent.test.ts`), so it works when the words are readable. The human's answer is simulated as "their own words", and `checkIntent` ran in process, not over the server.
Two suggestions, both in `src/orchestrator/intent-words.ts` (yours): (1) a day/month slash date like `3/11` is ambiguous (3 November or March 11), so instead of ignoring it, treat it as "disagrees" whenever the agent's logged date is a reading of it and the other reading is a real date, and ask the human; (2) a request with no date cannot be checked, so there is nothing to catch there, and that stays a documented limit.
Also done: `plan_undo` keep steps now use `route: "keep"`, and the airline after 24 hours is kept (your test 10b passes). `evals/PITCH_NUMBERS.md` is generated from the raw logs and lists what can be said with its caveat and what not to say. `SUBMISSION.md`'s claims table has new rows for the eval claims, including the ones we cannot make.

## Sarah

### trip-dmy story on /web/show (Karan, 2026-10-18)
- show.ts: new story "trip-dmy" ("11/3: the date that means two things"). detect() picks it when a date question ("You wrote ...") and a chain alert are both in the feed. The question, the human's 2 and Proxy's re-check go in scene 3, before the alert.

### Please redeploy the cloud judge copy from main (Karan, 2026-10-18)
The cloud copy still runs 8b7140e (`/web/show` is 404 there). Only you can update `bold-zero-0m4lf` in place (your org, your `~/proxy-manufact-link/`). From the repo root on your machine:
```
git fetch
rm -rf /tmp/proxy-deploy && mkdir /tmp/proxy-deploy && git archive origin/main | tar -x -C /tmp/proxy-deploy
rm -rf /tmp/proxy-deploy/.claude && mkdir /tmp/proxy-deploy/.mcp-use && cp -R ~/proxy-manufact-link/cloud /tmp/proxy-deploy/.mcp-use/
SHA=$(git rev-parse --short=7 origin/main)
echo "export const BUILD_COMMIT: string = \"$SHA\";" > /tmp/proxy-deploy/src/build-info.ts
for kv in PROXY_MODE=cloud PROXY_DEMO_ROUTES=1 INKBOX_DRY_RUN=1 PROXY_COMMIT=$SHA; do npx mcp-use servers env set bold-zero-0m4lf $kv --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c; done
npx mcp-use deploy /tmp/proxy-deploy --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c --json
```
No keys: leave every Inkbox, Stripe, Supabase and Anthropic variable unset. Then tell Karan; his agent checks `/status` (should show `$SHA`, mode `cloud`), `tools/list` (7 tools), `try_proxy_demo` and `/web/show`.

### From Karan's agent: /web/show, the presentation page (2026-10-17, while you were offline)
- **Offer choices (2026-10-18):** `reply.ts` parses KEEP PUSHING; `human.ts` reads a single number or KEEP PUSHING as the answer to an open offer question (`expectCounterDecision`), before PICK numbers; `protocol.ts` passes an optional typed `counter` on `accept_counter`; `routes.ts` `/web/reply` takes `choice` 1 to 9 and `keep_pushing`. /web/show has the options bubble with chips, the "Proxy asked you to choose" card, "You chose", and store credit shown as credit.
- **Live bug fix (2026-10-17):** `src/inkbox/protocol.ts` capped `round` at 3 in both parsers, so the new round-4 `accept_counter` was dropped by the hotel's bridge as an invalid request (silently: `demo:hotel` gives the bridge no store). The cap is now `MAX_ROUNDS` from `src/logic/negotiate-step.ts`. `bridge.ts` and `inbox.ts` now also log every dropped message. New `src/inkbox/protocol-e2e.test.ts` runs the full negotiation through `createInkbox().sendProtocolMessage`, `createMerchantBridge` and `createProtocolInbox` over an in-memory Inkbox; `protocol.test.ts` now rejects round 5 instead of 4.
- `src/inkbox/protocol.ts`: `parseMerchantMessage` keeps the merchant's one-line `message` (cleaned, one line, at most 200 characters) next to the typed fields, so the show page can display the hotel's own words on a live run. It is display only: `negotiate_step` never reads it (it is reported as ignored text), and it is never texted to the human. Test in `src/inkbox/protocol.test.ts`.
- `src/capture/capture.ts`: the sender map now knows Acme Cloud (`acmecloud.example` -> `saas`, and `saas` as a category fallback), so the plan story's receipt is the `saas` merchant and its undo emails billing instead of falling back to a card dispute.
- New in your folder: `src/web/show.ts` (the page) and `src/web/show.test.ts`; `src/web/routes.ts` serves `GET /web/show` and `POST /web/reply` also takes `{kind: "choice", choice: 1 | 2}` (it answers Proxy's intent question exactly like a "1" or "2" text). `/web/stage` is unchanged and stays the fallback.

### From Dhwanil: the `/web` feed wording
`src/web/page.ts` renders the event feed as `kind` plus `tool_name: outcome`. The suggested plain wording for each event is in the table under Karan ("review of the demo feed's agent-to-agent lines"). If you own the page text, a small lookup from `(kind, outcome prefix)` to a sentence is all it needs; the events do not change.

### From Dhwanil: the hotel's readable line (optional)
The hotel agent's counters and accepts now include a `message` string next to the typed fields. `parseMerchantMessage` in `src/inkbox/protocol.ts` drops it for `accept` and `counter` (it keeps only the typed fields, and `reason` for `deny`). If you want Proxy's own log to show the hotel's line, keep a cleaned `message` (one line, at most 140 characters, no control characters) on the parsed message. It is display text only; `negotiate_step` ignores it and lists it in `ignored_text`. Skip it if it complicates the contract.

### A2A transport ownership
Sarah owns A2A transport in both directions: inbound Proxy requests route to Dhwanil's hotel agent, and hotel replies route back to the orchestrator. If Inkbox inbound A2A does not work, use email between `proxy-agent` and `hotel-agent` with a structured JSON body. The protocol state machine is unchanged.

### From Karan: demo runs and a Vite warning
- **Demo runs:** each `/demo/reset` starts a new demo task id (`task_demo_1`, `task_demo_2`, ...), and every run reuses the `task-demo` Inkbox identity. Mail to `task-demo@...` is re-pointed to the current run before it reaches the Store, so nothing is deleted and earlier runs stay as history. Your capture code is unchanged.
- **Vite warning:** `npm run dev` warns about the variable `import(SDK)` in `src/inkbox/sdk.ts`. Add `/* @vite-ignore */` inside that `import(...)` to silence it and make sure Vite leaves the import alone.


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
- **Type gaps:** `EventKind` now has `imessage_in` (Karan added it) and the human channel logs inbound iMessages with it. `Action` has no confidence field; LLM-extracted Actions under 0.5 confidence are logged (`outcome: "low_confidence"`) and dropped, not raised.
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
| SMS out and in | **In works, out blocked by the carrier** | Inbound `START` arrived. Outbound is accepted by the API but fails with `40002` (carrier spam filter, "temporary"), twice, with and without a prefix. The human must text `START` first, from the same number that is registered. Retry later; iMessage is the working alert channel today. |
| iMessage | **Out: yes. In: works, with open questions** | The shared router number comes from `inkbox.imessages.getTriageNumber()` (ends 1193); the human texts `connect @proxy-agent` first, after which Proxy has its own line (ends 8624). Outbound alerts were delivered. Inbound, two replies from the registered number were stored and parse correctly: `UNDO ALL` (22:13 UTC, `undo_all`) and `KEEP` (22:42 UTC, `keep`). The `KEEP` showed up in the inbox later than I checked, so inbound can be slow, and `PICK 1 3` and a loose reply never appeared (they may not have been sent). A reply to Proxy's line also drew an automatic "Got it -- no changes made." that our code does not send (no webhook subscriptions existed then, nothing of ours replies); Inkbox support cannot yet say what produces it. Do not build a demo step that depends on a reply arriving within seconds. |
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
| `proxy-agent` | proxy-agent@inkboxmail.com | local number ends 1428 | Proxy itself: texts, iMessage, calls, support email, A2A |
| `hotel-agent` | hotel-agent@inkboxmail.com | none | Hotel merchant agent (A2A enabled) |
| `airline` | airline@inkboxmail.com | none | Airline merchant agent (A2A enabled) |
| `transfer-support` | transfer-support@inkboxmail.com | none | Transfer support desk (email) |

The human number is **not registered yet**: it needs Karan's phone number. Then run `HUMAN_PHONE=+1... node --env-file=.env src/inkbox/setup.mjs`; it sets Proxy's inbound phone filter to whitelist and allows only that number. Replies from any other number are also dropped in code.

### Review of Dhwanil's expected scoreboard results (Sarah, 2026-10-17; read-only; harness: `evals/`, 5 of ~30 scenarios)
I ran `runAll()` in memory and read `scenarios.ts`, `grader.ts`, `runner.ts`. Result today: Proxy 5/5 scenarios, 6/6 mistakes, 0 false alarms; naive 2/5, 0/6 mistakes, 3 false "done" claims.

**What is sound**
- Expected values are written by hand from the story, not copied from `compare`. I re-derived the arithmetic independently and it holds: $124,000 at risk = 41,200 + 64,000 + 18,800 + 0 (host email); agreed refund $1,144 = 41,200 + 54,400 (85% of 64,000) + 18,800; the demo clock (05:25 on 18 Oct) is 3h 40m before the flight's 24-hour window closes; Nov 3 is more than 7 days out, so the 24-hour rule applies.
- The `assumption` field on each scenario and the note in `run.ts` already say the naive arm is scripted, not measured.
- Cross-check I added (`src/capture/fixtures.test.ts`): capture turns the flight, hotel and transfer fixture emails (wrong and correct sets) into exactly the Actions in `fixtures/demo/*/actions.json`.

**Where the grader still checks itself or overstates**
1. **The naive arm's 0/6 is decided by the scenario author.** `runNaive` runs the same `compare` against `agent_belief`, and S01/S02 set `agent_belief` to the wrong dates, so it finds nothing by construction. This must be labelled on the scoreboard page and slides, not only in the console note: "scripted self-review, not a measured miss rate". The real rate comes from Layer 2 (a real agent).
2. **Rows the naive arm cannot do are shown as 0.** Chain members, undo outcomes and refunds are 0/6, 0/6 and $0 of $1,556 for naive because it has no capture or undo. Show "n/a, no capture or undo" so the table does not inflate the contrast.
3. **False "done" claims are structural.** `false_done_claim` is only ever true for the naive arm, so 3 vs 0 is not a comparison; the Proxy arm has no "done" claim to grade. Either grade Proxy's final status text too, or drop this row for Layer 1.
4. **The grader compares `action:field` only.** It never checks `expected`/`actual` values or evidence, so `compare` could report `dates` with the wrong dates and still pass. Add the expected and actual value to `ExpectedMismatch` (for S01: expected 2026-11-13, actual 2026-11-03) and compare them. Two mismatches on one action and field also collapse into one key.
5. **Refund expectations restate the mocks.** 54,400 is the hotel mock's 85% constant combined with the 80% preference, so that check says the mock is deterministic, not that Proxy recovered money. Keep it as a regression test and call it "agreed in Layer 1"; "recovered" must come only from Stripe test mode, as the docs require.
6. **Layer 1 bypasses capture, the orchestrator, Inkbox and Stripe.** Actions come straight from `simulateBookings`, so a capture bug cannot change a score. The host email is also not capturable (the fixture has no markup), so in the real system the 4th chain member arrives through `/demo/host-email`, not capture. Say so on the page; add one end-to-end scenario that feeds the fixture emails through capture.
7. **All five scenarios are the same NYC trip, by the author of the logic and the mocks.** 100% on these is expected and carries no rate. Do not quote percentages until the ~30 exist.

**Scenario gaps** (from the mix in `docs/04-architecture.md`): only wrong date, duplicate and two clean runs exist. Still missing: wrong amount, annual vs monthly, wrong item, late price change, late confirmation, hotel accept / deny, no-agent merchants, window closed, prompt injection. When you write them:
- Write `expected` before running, and commit it first.
- Keep the human's real request separate from the intent the agent logs (a mistake made in `log_intent` is invisible to `compare`).
- Late price change: nothing compares a receipt with a quote and `Intent` has no quote, so mark those scenarios "expected: not caught" unless the contract changes.
- Annual vs monthly works only on words in the summary; include a receipt with no term wording and one with `P1Y`, `12-month` or `yearly`.
- Duplicate rule: add a duplicate with a different price (missed today) and two legitimate identical purchases on one day (a false alarm today).
- Clean tasks: vary them (a refund line, a total exactly at budget, a SaaS plan with no term) instead of the same trip.
- Same-ref resends never reach `compare` (capture dedupes by ref); test them at the capture boundary.

### From Dhwanil: Layer 2 (live agent) is built and has a first real run
`LIVE_TRIALS=5 npx tsx --env-file=.env evals/live/run.ts` (code in `evals/live/`, results in `evals/results/layer2-*.json`). A real model (claude-haiku-4-5, `LIVE_EVAL_MODEL` to change) is the agent in five faulty environments: a signup that defaults to annual billing, a flight call that times out but goes through, an out-of-stock product with a "similar" one offered, a cheap hotel that sells out, and a clean control. Nothing scripts the agent's mistake. Truth is hand-written per task and does not use `compare`. Proxy runs in process (real compare, trace, plan_undo and negotiation against the mock merchants), not over MCP.
First run (5 trials per task and arm, so 25 episodes per arm; small samples, counts and not rates):
- Naive (agent checks its own work): 8 of 25 episodes had a real mistake; the agent said PROBLEM in 3 of those 8 and a false "done" in 5.
- Proxy: 5 of 25 episodes had a real mistake; 6 of 6 mistakes caught; 0 false alarms; $4,832.00 of refunds agreed (merchant-agreed, not Stripe-verified).
- Caveats: the arms are separate live runs, so the mistake counts differ between them. The faults are ones `compare` can see (duplicate, over budget), so 6 of 6 says little about unseen failure kinds. The substitute task (L3) produced no mistakes because the agent refused the substitute. The first run was discarded because the prompt had no date and the agent assumed 2024; fixed and rerun. Time to alert and Stripe verification are not measured here.
Not yet over the real MCP server: that needs Karan's server and the demo routes.

### From Dhwanil: scenarios ready for your review (Sarah)
`evals/scenarios.ts` has 34 scenarios. Every expected result is written by hand from the story and the human's real request, not copied from what the logic outputs. Please check them the way you offered, so the grader does not share `compare`'s blind spots. Run `npx tsx evals/run.ts` to see them against both arms and `evals/results/` for the raw log.

What I did with your earlier points:
- **Ground truth vs the logged intent:** a scenario has `intent` (what the human really asked) and an optional `logged_intent` (what the agent logged). Proxy compares against the logged one. S34 is the case where they differ: all four wrong bookings are counted as real mistakes that Proxy misses.
- **Known misses and known false alarms are documented, and fail loudly if they stop being true.** S15 (price rose after the quote, still under budget: no quote to compare against), S34 (wrong logged intent), S33 (two real identical transfers look like a duplicate). They count in the totals: 44 real mistakes, 39 caught, 5 documented misses, 1 documented false alarm.
- **The naive arm is labelled "scripted self-review"** in the CLI output and the raw log. What it notices follows each scenario's `assumption`, so those numbers are not a measured rate. Please look hard at the `assumption` lines: they are the soft spot.
- **Your blind-spot list:** term wording now includes `P1Y`, `P12M`, `/yr`, `/mo`; a charge seen by both email and Stripe is counted once; `item:` and `size:` match whole words (`size:M` no longer matches "Medium"). Not done: the quoted-price gap (S15 documents it), and the two-identical-purchases false alarm (S33 documents it).
- **Adversarial clean tasks:** S29 (total exactly at budget), S31 (SaaS receipt with no term), S32 (a $0 message), S28 (late confirmation). I did not add a refund line, because `Action.amount` has no negative case.
- Money here is what the merchants agreed. Verifying it against Stripe test-mode objects, as you asked, happens in Layer 2 and the orchestrator, not in Layer 1.

### Reversal Protocol transport (A2A both ways, email fallback; checked live 2026-10-17)
Full negotiation run between `proxy-agent` and `hotel-agent` on real Inkbox: request, counter (store credit), push back, accept (85%).
- **Over A2A:** counter in about 3s, accept in about 5s. The merchant answers on the same task; a counter leaves the task `input_required` and Proxy's push back continues that task.
- **Over email (same JSON, subject `[proxy:<type>] <negotiation_id>`):** counter in about 11s, accept about 22s. `sendProtocolMessage` falls back to it automatically when A2A fails, and says so (`via: "email"`).
- **Free-plan footer:** Inkbox appends `Sent via Inkbox (https://inkbox.ai)` to email bodies. The parser reads the outermost `{...}`, so this is handled, but anything else parsing these bodies must do the same.
- Receiving is by polling, so no public URL is needed. Karan: after building the orchestrator hooks, start the inbox once in `server.ts`:
  `createProtocolInbox({ access: createA2AAccess({ admin: createClient, handle: "proxy-agent" }), hooks, clock, store, trustedHandles: ["hotel-agent","airline"], trustedEmails: ["hotel-agent@inkboxmail.com","airline@inkboxmail.com"], since: <ISO time to resume from> }).start()`.
  It calls `hooks.onProtocolMessage` once per merchant answer. Only `accept`, `counter` and `deny` with valid typed fields get through; the `deny` reason is capped at 500 characters with control characters removed, and is never acted on. Messages from other senders, or older than `since`, are dropped and logged as `a2a` events. Pass the time you last stopped as `since` after a restart; the default is "now", so history is never replayed.
- Dhwanil: the hotel's side is `createMerchantBridge({ access: createA2AAccess({ admin: createClient, handle: "hotel-agent", apiKey: process.env.INKBOX_HOTEL_AGENT_API_KEY }), agent: merchants.agent("hotel"), clock, proxyHandle: "proxy-agent", proxyEmail: "proxy-agent@inkboxmail.com" }).start()`. It reads Proxy's requests (A2A, or email), calls your `MerchantAgent.respond(message, now)`, and answers on the same channel. Only Proxy may ask; a closed task is never answered twice. The A2A key comes from `INKBOX_HOTEL_AGENT_API_KEY` (given to Dhwanil separately; A2A rejects the admin key). Checked live against the real `merchants.agent("hotel")` from `src/merchants` (booked in memory with `createFakeDeps().deps`): request_reversal, counter (store credit $640), push_back, counter (85% partial, $544), accept_counter, accept ($544). Over A2A the whole run took 6s; over email 29s. Note the hotel's push back answer is a second *counter*, so Proxy must send `accept_counter` (three Proxy messages), and `negotiate_step` has to decide that from preferences (min 80%).
- Cost to know: Proxy mints one scoped Inkbox API key per process start unless `INKBOX_PROXY_API_KEY` is set. Set it for the deployed server.

### For Karan: what is left to wire (Sarah, 2026-10-17)
- `src/orchestrator/runtime.ts` already mounts capture and the three Inkbox routes. Still to add: `createWebRoutes({ store, clock, channel: human, humanNumber: env.HUMAN_PHONE, controls: env.PROXY_DEMO_ROUTES === "1" })` from `src/web` (the demo page at `GET /web`; its UNDO ALL / PICK / KEEP buttons call the same `human.handleInbound` as a text), and `createProtocolInbox(...).start()` from `src/inkbox` (see the Reversal Protocol section). `npx tsx src/web/preview.ts` shows the page with fake data at http://localhost:4173/web.
- `log_intent` swallows the real error from `createTaskAddress` (`catch {}` in `src/tools/handlers.ts`). Log it, or the next failure will be as opaque as the last one.
- `task-demo@inkboxmail.com` did not exist on 2026-10-17 (404) and now does. It was created with the same client call `log_intent` uses, on the first try, with five identities in the org. I could not find a documented identity cap on the free plan and Inkbox exposes no plan or limit endpoint. For the demo, keep reusing `task_demo` (`INKBOX_DEMO_TASK_ID`) instead of creating an identity per run.
- Keys are in two files outside the repo, mode 600: `~/proxy-server-key.env` (`INKBOX_PROXY_API_KEY`, scoped to `proxy-agent`) and `~/proxy-merchant-keys.env` (`INKBOX_HOTEL_AGENT_API_KEY`, `INKBOX_AIRLINE_API_KEY`, `INKBOX_TRANSFER_SUPPORT_API_KEY`). They have to be handed over by a person; nothing in the repo or this file contains them.
- Inkbox support (messaged over A2A, answered 23:03 UTC) checked the account: `proxy-agent` is active and iMessage-enabled, the human's number has inbound allow rules, and they can see stored inbound iMessages from it at 21:33, 22:13 and 22:42 UTC. They could not identify what generates "Got it -- no changes made.", found no supported switch to turn it off, and escalated both issues to their team without a fix. For outbound SMS they confirmed the number is ready and the recipient is opted in; the carrier filtering (error 40002) is downstream of Inkbox, and the only supported remedy is registering our own 10DLC campaign in the Console ($20/month, no guarantee). If we chase it: send support the exact UTC send time, sender address, destination number and conversation id of a reply that went missing. For the demo, use the page buttons as the primary reply path and iMessage as the outbound alert.

### Inkbox webhooks and the tunnel (Sarah, 2026-10-25)
- Subscribed to `https://hissing-silver.tunnel.mcp-use.run`: `proxy-agent` `text.received` -> `/inkbox/text` and `imessage.received` -> `/inkbox/imessage`; `task-demo` `message.received` -> `/inkbox/inbound`. Inkbox delivers per identity (there is no org-wide webhook), and each delivery carries `Authorization: Bearer <INKBOX_WEBHOOK_TOKEN>`.
- **Until the server has the same `INKBOX_WEBHOOK_TOKEN` and this branch's verifier, every delivery gets 401.** I checked: the tunnel server answers 401 "bad signature" with and without the token. Karan: merge PR #10 and set `INKBOX_WEBHOOK_TOKEN` (value in `~/inkbox-webhook-token.env`, to be handed over by a person) and `INKBOX_PUBLIC_URL` (the tunnel URL).
- **When the tunnel URL changes:** `npx tsx --env-file=.env src/inkbox/subscribe-cli.ts https://<new-host> task-demo` replaces our old subscriptions with new ones. New task inboxes subscribe themselves in `createTaskAddress` when `INKBOX_PUBLIC_URL` and the token are set.
- The server on the tunnel has no `HUMAN_PHONE`: the newest event is `imessage_out chain_opened:not_sent_no_human_number`, so no alert text is sent. Set `HUMAN_PHONE` in its environment (the registered number is in Sarah's `.env`).
- `GET /web` on the tunnel loads (200, `controls: true`), and `/web/state` shows eight old chains from earlier runs; the page now lists open chains first and hides earlier ones behind a toggle. Reset the demo store between rehearsals.

### Stage page for the demo video (Sarah, 2026-10-25)
- `GET /web/stage` is a full-screen 16:9 dark page for screen recording: left "The mistake" (bookings appear one by one, wrong dates in red), middle "Proxy" (Recovered $X of $Y counting up, rows turn green with a check when Stripe confirms, the countdown, the human's thread), right "Agent to agent" (Proxy and the hotel agent / transfer desk as bubbles, then "Refund confirmed in Stripe"). It polls `GET /demo/feed?task_id=<id>` every second (`?task_id=` on the page URL, or the server's current run if omitted). It scales to any window and always keeps 16:9.
- **Rehearse it without the server's feed:** `npx tsx src/web/preview.ts`, then open `http://localhost:4173/web/stage?fixture=1` (the demo story plays by itself, one step every 2.5 s, `&step=N` freezes a frame; `GET /web/stage-fixture?restart=1` starts it again). 19 steps; the end state is "Recovered $1,144 of $1,240".
- **Karan: what `GET /demo/feed` must return.** The exact TypeScript shape is `StageFeed` in `src/web/stage-feed.ts` (import it, or copy it). In short: `task_id`, `now` (the run's clock), `task { goal, intended_dates, budget_total }`, `bookings[]` (`id, merchant, category, summary, amount, dates, at, wrong?`), `chain { chain_id, state, window_ends_at, total, recovered, rows[] (id, label, amount, state, refunded, verified) } | null`, `human[]` (`at, direction out|in, channel, text`, the alert and the replies as they happen) and `conversations[]` (`with, name, entries[] (at, from proxy|merchant|stripe, kind request|counter|push_back|accept_counter|accept|deny|email|reply|stripe|correction, text)`). `recovered` is cents confirmed in Stripe, `total` is the whole chain. `verified` must be true only when Stripe shows the refund. Every entry needs a stable `at` and text, because the page keys on them so only new entries animate. If the real feed differs, tell me and I will adapt the page, not the other way round.
- **`/web` shows only the current run now.** Pass `currentTask: () => proxy.deps.demo?.current` to `createWebRoutes` (it falls back to the newest run, and `?all=1` shows everything, `?task_id=` picks one). Each button sends its own `chain_id`, so a tap lands on the chain it was drawn for.
- **Replies no longer match kept or expired chains** (`src/inkbox/human.ts`): an active chain wins, a finished one is used only when nothing is active, and kept or expired chains get "Nothing is waiting on you right now". An explicit `chain_id` (the page buttons) is always honored.
- **Phone copy.** Checked at 390 px: replies are short lines with the numbers on their own lines. `composeChainAlert` in `src/inkbox/alert.ts` now lays the alert out as: the mistake, a blank line, "4 things affected · $1,240 at risk", "Reversible for 3h 40m", a blank line, "Reply UNDO ALL, PICK or KEEP." (about 150 characters). The text actually sent comes from your `chainAlert` in `src/orchestrator/copy.ts`, which is one run-on paragraph; Karan, please use the same layout there (or call mine) so the phone in the video reads the same as the page. The UNDO ALL acknowledgement is deliberately still the old single sentence ("Got it. Starting the undo. I'll text you as each step is confirmed in Stripe."), because `src/orchestrator/workflows.test.ts` asserts it word for word; the two-line version reads slightly better on a phone and I'll switch it when those assertions change. The PICK list is one short line per item ("Flight, Nov 3 · $412", "Host email, Nov 3 · no charge").

### Cutover to the deployed server, and rollback (Sarah, 2026-10-25)
Values: `<URL>` is the deployed base URL with no path (for example `https://<slug>.run.mcp-use.com`), `<SLUG>` the server slug, `<ORG>` the Manufact organization id or slug, `<TUNNEL>` Karan's current tunnel URL (it changes every time the tunnel restarts, so ask him), `<DEP>` a deployment id from `npx mcp-use deployments list --org <ORG> --server <SLUG>`. Run everything from the repo root with Sarah's `.env` (it has `INKBOX_API_KEY` and `INKBOX_WEBHOOK_TOKEN`). **Do not start until Karan says go.**

**Before "go" (safe: changes nothing)**
1. `npx tsx --env-file=.env src/inkbox/subscribe-cli.ts --list` shows where the webhooks point now.
2. `npx tsx --env-file=.env src/inkbox/subscribe-cli.ts <URL> task-demo --dry-run` shows what a cutover would replace.
3. The deployed server must already have these env vars (Manufact dashboard, or `npx mcp-use servers env set <SLUG> KEY=VALUE --org <ORG>`; add `--secret` for every key, token and the Supabase service role key, so it is stored write-only): `HOST=0.0.0.0`, `PORT=3000`, `INKBOX_API_KEY`, `INKBOX_PROXY_API_KEY`, **`INKBOX_WEBHOOK_TOKEN` (the same value as in Sarah's `.env`)**, `HUMAN_PHONE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `STRIPE_*` / `ANTHROPIC_API_KEY` if wanted. `INKBOX_DRY_RUN` must be unset (it makes the webhook routes accept unsigned requests).
4. `npx tsx --env-file=.env src/inkbox/cutover-check.ts <URL> --no-send` should pass the MCP and webhook-auth checks. The subscription check fails until step 2 below, which is expected.

**Cutover (about two minutes)**
1. Karan stops the laptop server, or sets `INKBOX_DRY_RUN=1` on it, so two servers do not both poll Inkbox and share one Supabase. If `npm run demo:hotel` is running anywhere, restart it with `MCP_URL=<URL>/mcp`, because it answers through the server that holds the bookings.
2. `npx mcp-use servers env set <SLUG> INKBOX_PUBLIC_URL=<URL> --org <ORG>`, then `npx mcp-use deployments restart <DEP> --follow` (or the dashboard: Servers, the server, Environment, Redeploy). Wait until `npx mcp-use deployments get <DEP>` shows it running.
3. `npx tsx --env-file=.env src/inkbox/subscribe-cli.ts <URL> task-demo` re-points the three webhooks (`proxy-agent` text and iMessage, `task-demo` email) and prints the table.
4. `npx tsx --env-file=.env src/inkbox/cutover-check.ts <URL>` runs the full check: MCP `initialize` and `tools/list` (six tools), webhook with and without the token (200 and 401), subscriptions all on `<URL>`, then it sends one alert to `HUMAN_PHONE`, waits for you to reply UNDO ALL, and looks up Inkbox's delivery log for that webhook and requires a 2xx from the deployed server. For the server's own logs: `npx mcp-use deployments logs <DEP>` (add `--build` for build logs).
   The reply the server sends back with no open chain is "Nothing is waiting on you right now."; that is the expected proof it received it. `/health` is not a check: the Manufact gateway answers `/health` itself, even for a slug that does not exist.

**Rollback to Karan's tunnel (about two minutes)**
1. Karan starts the laptop server with its tunnel and tells Sarah the URL (`<TUNNEL>`; the last known one was `https://hissing-silver.tunnel.mcp-use.run`, which may be stale). It needs the same `INKBOX_WEBHOOK_TOKEN` as in Sarah's `.env`.
2. `npx tsx --env-file=.env src/inkbox/subscribe-cli.ts <TUNNEL> task-demo` points the webhooks back (the same command as the cutover; it replaces, it does not add).
3. `npx tsx --env-file=.env src/inkbox/cutover-check.ts <TUNNEL>` (add `--no-send` to skip the real alert) must pass.
4. Stop the cloud copy so it does not also poll Inkbox: `npx mcp-use deployments stop <DEP> --yes`. Set `INKBOX_PUBLIC_URL=<TUNNEL>` on the laptop's `.env` if new task inboxes should subscribe themselves to it.
Rehearsed today without changing anything: `--list`, `--dry-run`, and `cutover-check.ts --no-send` against the tunnel (all pass; it fails correctly on a URL that is not ours), plus unit tests that a rollback re-points the subscriptions exactly and leaves any other subscription alone.

### Proxy's contact card on the phone (Sarah, 2026-10-25)
- `proxy-agent` has display name "Proxy" and contact sharing on (`contactSharingEnabled: true`). The Inkbox docs say a **dedicated iMessage line** (ours, ends 8624) shares the identity's display name, and its avatar if there is one, automatically. They do not say how the recipient's phone shows it, and they say nothing about contact sharing for SMS numbers (ours, ends 1428).
- iOS labels a name it has learned for an unknown sender "Maybe: Proxy". There is no setting on our side that removes "Maybe:". The fix is on the phone that records the video: open the thread, tap the sender, **Add to Contacts**, and name it "Proxy" (or accept the shared contact card if it appears). Do this for the iMessage line and, if SMS is shown, the SMS line, so both read "Proxy".
- No avatar is set. SDK 0.7.19 has no avatar upload that I could find; if a photo matters for the video, set it in the Inkbox Console. Unverified: I could not test on a real iPhone.

### Stage page, second round (Sarah, 2026-10-25)
Reworked after the first recording. `GET /web/stage` no longer forces a 16:9 box: it fills the window (about 17 px base text at 1920x1080, 13 px at 1440x900, never under 12 px), the three columns stack below 1100 px wide, and there is no page-level scrollbar above that width.
- **Progress line** under the title: Mistake detected, Human alerted, Human replied, Negotiating, Refunds confirmed, Rebooked. The current step is highlighted. It is computed from the feed (the chain, the human's texts, the conversations, whether every row is verified, whether anything was rebooked), so no new field is needed.
- **Left:** "Booked by the agent" (red, the mistakes), then "Rebooked for Nov 13" (green) once the redo arrives. A booking counts as rebooked if `booking.rebooked` is true or the feed's `entries` has a `redo` entry for its id; your feed already has those entries, so nothing to change.
- **Middle:** a phone-style strip pinned at the top (the alert Proxy sent, the human's reply with its time, and the latest later text on one line), then Recovered $X of $Y, then one row per action. A verified row shows what came back ("$544 of $640"). A row says "Refunded by your agent" if `row.by_agent` is true or `entries` has a `self_undo` entry for its id (yours does).
- **Right:** one thread per merchant, in order from the first message, headed "Harborview Hotel agent · A2A" or "Metro Transfer support · email" (the channel comes from the message kinds: request, counter, push back, accept are A2A; email, reply, correction are email; a thread with both says "A2A, then email"). Stripe receipts stay inside their thread. Thread names are mapped on the page for `hotel`, `transfer` and `host`; the feed's own name is used for any other merchant.
- **Scrolling:** each column scrolls on its own with a fixed header, follows the newest entry, stops following when the viewer scrolls up (a "New" pill appears and takes them back), and fades at a cut edge.
- **Times** are the demo clock's time of day (UTC), for example 5:25 AM. The clock is simulated, so they are not real times.
- **Try it:** `npx tsx src/web/preview.ts`, then `http://localhost:4173/web/stage?fixture=1` (add `&long=1` for a long run with more bookings and more back-and-forth, `&step=N` to freeze a frame). `GET /web/stage-fixture` takes the same `step` and `long`.
- Optional fields added to `StageFeed` in `src/web/stage-feed.ts`: `StageBooking.rebooked`, `StageRow.by_agent`, and `entries` (your timeline, passed through). All optional; your current feed works as it is.

### Manufact deploy: DONE (Sarah, 2026-10-25)
- **Deployed MCP URL: `https://bold-zero-0m4lf.run.mcp-use.com/mcp`** (server `proxy`, slug `bold-zero-0m4lf`, region AUTO, Node 22, deployment `8dd1a3be-8f82-47ff-8198-3eedbbdda220`, status running). Built from `origin/main` at `ad453f3`.
- **Manufact organization ID: `9833fb6a-873c-4b80-b5a6-16c3f30ba17c`** (slug `org-3e8505eb-iovbr`, "Sarah Khadder's Projects", Sarah is owner). It owns the server, so this is the ID for the submission form.
- **Verified on the deployed URL** (over MCP, not `/health`): `initialize` answers as `proxy` 0.1.0; `tools/list` returns all six tools; `resources/list` returns `proxy://mistakes` and the live-chain view; a real call (`review` on an unknown task) returns `{ok:false, code:"not_found", retryable:false, next_action:"fix_now"}` with `isError`; `/web`, `/web/stage`, `/web/state` and `/web/stage-fixture` return 200; no errors in the runtime log. `/demo/feed` is 404 because demo routes are off.
- **How it was deployed, and why not from GitHub:** the Manufact GitHub App is not connected to Sarah's org and the repo belongs to Karan, so `mcp-use deploy` stops with `github_installation_required`. I used the managed upload (`--no-github`) from a clean `git archive` of `origin/main` (tracked files only, no `.env`, no `node_modules`; scanned: no keys, no tokens, no phone numbers). It is **not linked to GitHub**, so pushes to `main` do not redeploy it.
- **Configuration (no secrets set):** build `npm run build`, start `npm start`, env `HOST=0.0.0.0`, `PORT=3000`, `INKBOX_DRY_RUN=1`, `INKBOX_DEMO_TASK_ID=task_cloud`. There are no Supabase, Inkbox, Stripe or Anthropic keys on it, so it uses an in-memory store, a stand-in Inkbox and fake payments, and cannot touch Karan's Supabase or the live webhooks. `PROXY_DEMO_ROUTES` is **not** set, so `task_cloud` (the demo identity) is unused until demo routes are turned on: `npx mcp-use servers env set bold-zero-0m4lf PROXY_DEMO_ROUTES=1 --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c`, then restart the deployment. Because `INKBOX_DRY_RUN=1` also makes its webhook routes accept unsigned requests, it must never be the server Inkbox delivers to; this is the demo/judging copy.
- **Redeploy to the same server** (untested; it needs a fresh export plus the saved link file, which holds ids only, in `~/proxy-manufact-link/`): `rm -rf /tmp/proxy-deploy && mkdir /tmp/proxy-deploy && git archive origin/main | tar -x -C /tmp/proxy-deploy && rm -rf /tmp/proxy-deploy/.claude && mkdir /tmp/proxy-deploy/.mcp-use && cp -R ~/proxy-manufact-link/cloud /tmp/proxy-deploy/.mcp-use/ && npx mcp-use deploy /tmp/proxy-deploy --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c --json`. Logs: `npx mcp-use deployments logs 8dd1a3be-8f82-47ff-8198-3eedbbdda220` (add `--build` for the build). A stray second deployment (`6f49b8e3-...`) shows as stopped; it was the superseded first attempt.
- **Not done:** the Inkbox cutover. This copy is dry-run, so webhooks stay on Karan's tunnel; a real cutover needs real keys on a cloud server and Karan's go (steps are in "Cutover to the deployed server, and rollback" above).

### Cloud judge copy: airtight pass (Sarah, 2026-10-25)
**Status: DONE. Redeployed from `main` at `51feb13` (PRs #25 and #26: `try_proxy_demo`, `PROXY_MODE=cloud`, the boot seed, `/status`).** `demo-v1` is the only tag so far; a `demo-v2` tag did not exist when I deployed, so I deployed `origin/main` itself and set `PROXY_COMMIT=51feb13`. If `demo-v2` lands on a later commit, redeploy with the runbook below.
- **Deployment:** `fb0322aa` running, server `bold-zero-0m4lf` (id `2b61bdbf-04d7-4b8b-9216-93953d5a2666`), same URL. Env on the server (names only): `HOST`, `PORT`, `INKBOX_DEMO_TASK_ID`, `INKBOX_DRY_RUN=1`, `PROXY_MODE=cloud`, `PROXY_DEMO_ROUTES=1`, `PROXY_COMMIT=51feb13`. **No keys of any kind.**
- **`cloud-verify.ts --health /status --commit 51feb13`: all 8 checks pass.** `/status` returns `{"ok":true,"commit":"51feb13","mode":"cloud","sandbox":"OK","services":{...all "disabled (cloud mode)"}}`; `tools/list` shows seven tools; `list_chains` shows `sandbox_example`; `try_proxy_demo` ends at $1,144 of $1,240 (0.4 s); the three Inkbox webhook routes are 404. Also: `POST /demo/reset`, `/web/reply` and `/merchants/hotel/agent` are 404; `/demo/feed`, `/web/stage`, `/web/state` are 200.
- **The stage page on the cloud URL** renders from the real feed (Live, $1,144 of $1,240, all rows done, three threads, rebooked group, no page scrollbar, no console errors). Its Stripe lines say "(simulated)"; the middle-column rows said plain "Confirmed in Stripe" until this PR, which makes them say "Confirmed in Stripe (simulated)" whenever the feed does.
- **Manufact checklist: not run.** It is a dashboard feature (Publish, Checklist, Run); I have no browser session on Sarah's Manufact account, only a CLI login. Sarah runs it ($0.10, private); see the steps in the final report.

**Findings that change how the PR should be written**
- **The Manufact gateway answers `/health` itself** with `{"status":"healthy","timestamp":...}`, on every slug, including ones that do not exist. A `/health` that reports the commit and `PROXY_MODE` can therefore never be read on the cloud URL. Serve it on another path (for example `/status` or `/web/health`) and tell me which; `src/inkbox/cloud-verify.ts` takes `--health <path>`.
- **The Inkbox webhook routes currently return 200 on the cloud copy**, because `INKBOX_DRY_RUN=1` makes the verifier accept unsigned requests. With `PROXY_MODE=cloud` they must not be mounted at all (404), as asked.
- A server created by managed upload **cannot be switched to GitHub auto-deploy in place** (the CLI says a linked server cannot be replaced in place; the reverse is the same), and the GitHub App has to be installed on `karan6705/tripwire` and connected to *this* Manufact organization, which belongs to Sarah. Doing it means a new server and a new random URL, so the form URL would change. Not worth it: a manual redeploy takes two minutes. If Karan wants auto-deploy anyway, he deploys from his own org and Sarah's form entry uses his URL and org id.

**Redeploy runbook (tested twice: same server id and URL both times: the same command redeployed the same server and kept the URL)**
1. `git fetch --tags && git rev-parse --short demo-v1` (note the commit). `git checkout sarah && git merge origin/main`.
2. `npx mcp-use servers env set 2b61bdbf-04d7-4b8b-9216-93953d5a2666 PROXY_COMMIT=<short sha> --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c` (**the server id, not the slug: the slug fails with a UUID validation error**). `PROXY_MODE=cloud`, `PROXY_DEMO_ROUTES=1`, `INKBOX_DRY_RUN=1`, `HOST`, `PORT` are already set. Set no keys. `PROXY_COMMIT` is needed because the export has no `.git`, and it must be the commit you export.
3. `rm -rf /tmp/proxy-deploy && mkdir /tmp/proxy-deploy && git archive <the same commit or tag> | tar -x -C /tmp/proxy-deploy && rm -rf /tmp/proxy-deploy/.claude && mkdir /tmp/proxy-deploy/.mcp-use && cp -R ~/proxy-manufact-link/cloud /tmp/proxy-deploy/.mcp-use/`
4. `npx mcp-use deploy /tmp/proxy-deploy --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c --json`. It prints a `deploymentId`; **Each upload makes two deployments and the first one is shown as `stopped` (superseded); do not wait on it.** Find the running one with `npx mcp-use deployments list --org 9833fb6a-873c-4b80-b5a6-16c3f30ba17c --server 2b61bdbf-04d7-4b8b-9216-93953d5a2666 --json` (newest first) and poll until it is `running` (about 100 s). Same server id, same URL.
5. `INKBOX_DRY_RUN=1 npx tsx src/inkbox/cloud-verify.ts https://bold-zero-0m4lf.run.mcp-use.com --commit <sha> --health <path>` checks: the status path names the commit and `PROXY_MODE=cloud`; `tools/list` shows seven tools; `list_chains` shows `sandbox_example`; `try_proxy_demo` finishes at $1,144 of $1,240; the three Inkbox webhook routes are 404. It makes no Inkbox, Stripe, Supabase or Anthropic calls. Run it once without `--no-demo` (it runs the sandbox).
Against today's copy it correctly fails the new-code checks and passes the rest (tools, errors, timing).

**Cold start and sleep (measured today on the cloud URL)**
- First request after a long idle (about 40 minutes): **1.76 s**; the next three: 0.40 to 0.83 s. After about 6.5 minutes idle: **1.65 s, then 1.14 s, then 0.56 s**. After a redeploy, a first `tools/list` took about 1.3 to 1.4 s. So there is a cold start of roughly 1 to 1.2 s extra that fades over the first two or three requests, not a failure. (Idle gaps shorter than that were not measured; the 6.5-minute test was cut short of 9 because my own verification call touched the server.) The Manufact docs describe a **"Prevent Scale to Zero"** setting that "keeps your server warm so clients never hit a cold start", on **paid plans only**; they publish no idle timeout and no wake-up time, and the CLI does not expose the setting (Settings, Deployment resources, in the dashboard).
- **To keep it warm until 10:00 AM:** (a) Sarah turns on Prevent Scale to Zero in the dashboard if the plan allows it, or (b) from any machine that stays awake, run `caffeinate -i bash -c 'while true; do curl -s -o /dev/null -X POST https://bold-zero-0m4lf.run.mcp-use.com/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"; sleep 240; done'` (stop it with Ctrl-C), and (c) always run `cloud-verify.ts --no-demo` at about 9:45 so the first judge request is not the cold one.

**Event page (read today, https://events.ycombinator.com/MakeSomethingAgentsWant)**: "Submissions Due + Live Demos" is **Sunday Oct 18, 10:00 AM**; judging completes 11:00, winners 12:15. Prize tracks: Manufact (Best MCP Server for Agents), Inkbox, Stripe, Armature (Best AX), Primitive, Insforge, Blaxel. The page gives **no submission channel for the Inkbox track**; the only form is Manufact's (`url.mcp-use.com/yc-submit`). The Manufact track lists a judge named "Andrew Khadder"; if that is a relative of a team member, disclose it to the organizers. The mcp-use Discord needs a login and was not checked.

### How the pieces plug in (for wiring at 5 PM)
- `src/db` (**checked live against the team Supabase project on 2026-10-17**: intent, action, chain, step, lesson and event round-trip; the `events` trigger refuses UPDATE and DELETE; test rows with `run_id: live-check` remain because events cannot be deleted): `createStoreFromEnv()` (Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise in memory). Run `src/db/schema.sql` once in the Supabase SQL editor; the `events` table rejects updates and deletes with a trigger.
- `src/capture`: `createCapture({ store, hooks, clock, llm? })`; routes: `createInboundEmailRoute({ capture, fetchFullMessage })` at `POST /inkbox/inbound`. Mock merchants can use `deliverToCapture(capture)` as their `deliver`.
- `src/inkbox`: `createInkbox()` implements `Inkbox` (`INKBOX_DRY_RUN=1` logs instead of sending). `createHumanChannel(...)` plus `createHumanRoutes(channel)` give `POST /inkbox/text` and `POST /inkbox/imessage`. `composeChainAlert(...)` builds the one text per chain.
- `src/web`: `createWebRoutes({ store, clock, channel, humanNumber, controls: process.env.PROXY_DEMO_ROUTES === "1" })` gives `GET /web` (the page), `GET /web/state` and `POST /web/reply` (UNDO ALL / PICK / KEEP buttons; they go through the same human channel as a text, so they are idempotent and respect the window). `store` must be `createStoreFromEnv()` or `createMemoryStore()` because the feed needs `recentEvents`. The scoreboard panel shows whatever JSON `scoreboard()` returns; Dhwanil, give me the results file path and format when it exists.
- Tests: `npm test`.


### From Karan (2026-10-17)
- Merged `origin/sarah` (03ea0e2) into main. `.env.example` keeps Dhwanil's key names (`INKBOX_AIRLINE_API_KEY`, `INKBOX_HOTEL_AGENT_API_KEY`, `INKBOX_TRANSFER_SUPPORT_API_KEY`), because those are what the code reads. Your a2a.ts comment still says `INKBOX_KEY_HOTEL_AGENT`.
- `createProtocolInbox` starts once in server.ts (real Inkbox only), with hooks that point at the current runtime. Restart point: no Store change was needed. Each processed merchant message is written as a Step with its receive time, and the inbox resumes from the latest one minus 2 minutes. Replays are dropped by negotiation, type, round and amount.
- Two servers polling the same proxy-agent inbox would both act on each answer. Run only one real-Inkbox server at a time.
- `/web` is mounted from the runtime. Its buttons are on with `PROXY_DEMO_ROUTES=1`; without `HUMAN_PHONE` they act as a placeholder number that is never texted.
- `INKBOX_PROXY_API_KEY` isn't in `.env` yet, so each start mints a key. Please send it.


### From Karan: QA pass on the live demo (2026-10-18)
Found in Karan's live run on port 3000, read from `/web/state`:
1. **Replies went to an earlier run's chain.** `currentChain()` in human.ts picks the chain with the latest alert `sent_at`, across all chains, including terminal and expired ones. Each demo reset sets the simulated clock back, so the earlier run's alert (14:00:29) looked newer than the current run's (14:00:23). The UNDO ALL went to that older chain, which was already undoing, so nothing happened, but "Got it" was still sent.
   - Fixed on my side: alert times now only move forward, a reset closes earlier runs' chains as `expired`, and the orchestrator re-points any reply in demo mode to the current run.
   - Please: leave `expired` (and `kept`) chains out of the candidate pool, and have `POST /web/reply` use the `chain_id` it is given. Today it ignores it, so the button and a text can act on different chains.
2. **Channel split.** The demo-page buttons go through `handleInbound` with `via: "sms"`, so the reply went by SMS from another number while the alert went by iMessage. The runtime now sends every message to the human on the alert channel (`HUMAN_ALERT_CHANNEL`, default iMessage), whatever `via` says. You may want `via` to come from the chain's last alert.
3. **STOP, RESUME and correction texts.** `parseReply` treats STOP as a carrier opt-out (ignored) and "no, the 13th" as unknown. `src/orchestrator/human-front.ts` now handles STOP/PAUSE, RESUME/GO, correction texts and the YES/NO to "Just to check..." before your channel sees them. Move that into your parser whenever you like; the behavior to keep is in `src/orchestrator/workflows.test.ts` (tests 5 and 6).
4. **The Supabase store can't update an intent.** `putIntent` with a new key POSTs a second row with the same `task_id`. A confirmed correction that changes the dates needs an update (e.g. `updateIntent(intent)`). Until then the undo still runs, and the intent keeps its dates.
5. `createMerchantBridge` ignores everything older than its start by default, so a request Proxy sent before `npm run demo:hotel` started was never answered. The script now passes `since` (the last 30 minutes, or `HOTEL_AGENT_SINCE`).
6. Proxy no longer uses `composeChainAlert`. Alerts and progress texts come from `src/orchestrator/copy.ts` (human dates, days past 48 hours, "$828 at risk of $1,240").
7. The `/web` page marks a row verified when `state === "verified"`. A host correction is done with state `accepted` and no money; `get_chain` reports those in `_meta.corrected`.


### From Karan: the demo feed for the stage page (GET /demo/feed)
- `GET /demo/feed` (demo routes only) now returns your `StageFeed` from `src/web/stage-feed.ts`, built from the live run, plus one extra field, `entries`: the full plain-English timeline (`seq`, `at`, `actor`, `kind`, `text`, `data`). No keys, tokens or phone numbers.
- Checked on port 3001: `/web/stage` shows all three columns from the live feed, and counts up to "$1,144 of $1,240". Conversations come back in the order hotel, transfer, host; the host one holds the correction and its reply.
- `bookings` includes the rebookings after the redo (`wrong: false`, Nov 13). `wrong` is true for everything in the chain.
- `verified` is true only for Stripe-confirmed refunds; the host row is `state: "accepted"`, `verified: false`, which your page already shows as "Corrected".
- In `npm run demo:offline-stage` payments are simulated, and Proxy's texts say "Stripe (simulated)". Your channel's reply "Got it. … confirmed in Stripe." still says Stripe there; could it say "confirmed" only, or take the wording from Proxy?


### From Karan: stage page status label (2026-10-18)
- The top-right status says "Live" on a live run already: line 422 of `src/web/stage.ts` shows "Replaying the demo story" only when the page URL has `?fixture=…`. If someone saw "Replaying" on a live run, the URL still had `?fixture=1` from a rehearsal: open `/web/stage` with no query.
- One small request: `q.get("fixture")` is truthy for `?fixture=0` too. Treating only `1`/`true` as replay would avoid that trap.
- The phone alert now uses your multi-line layout (the mistake, what the agent already undid, a blank line, the numbers, the window, a blank line, the choice). The tests no longer pin your "Got it" acknowledgement's wording, beyond `/^Got it/` in the rehearsal and test 1's check that it arrives before any progress text, so you can switch it to two lines.

## Dhwanil

### From Karan's agent: changes in your folders while you were offline (2026-10-17)
- **Offer choices (2026-10-18):** `src/merchants/hotel.ts` keeps every offer it made open and honors the one named in `accept_counter.counter` (store credit or the partial refund); an offer it never made is denied.
- **The richer hotel negotiation (Karan's ask):** `src/logic/negotiate-step.ts` now allows 2 push backs and 4 rounds (`MAX_ROUNDS = 4`, `MAX_PUSH_BACKS = 2`). The new rule: an offer that meets the human's minimum but is below the full price gets one push back for the full amount (the anchor), only while a round is left to accept in; once anchored (the last push back was on an acceptable partial refund), it accepts. An acceptable offer after the limit still goes to the human, and only typed fields are read. `src/merchants/hotel.ts`: the store-credit counter cites the 7-day policy, a second push back gets the same 85% as "our final offer", and the persona lines are reworded. The demo outcome is unchanged ($544 of $640; $1,144 of $1,240). Tests updated to the new sequence: `tests/logic/negotiate-step.test.ts`, `tests/merchants/hotel.test.ts`, `tests/merchants/narrate.test.ts`, `tests/evals/runner.test.ts` (S01 now uses 4 rounds; rounds are only a raw field, no score changes).
- `evals/scoreboard.ts`: a light theme for `/scoreboard` to match the new `/web/show` page. Only the colour tokens, font stack and panel shadow changed; the rendered body (every number and caveat) is byte-for-byte the same, checked against the previous snapshot. `src/scoreboard-snapshot.ts` was regenerated with `npm run scoreboard:snapshot`.

### From Karan: numeric dates in the intent check are on main (2026-10-17)
- `checkIntent` (`src/orchestrator/intent-words.ts`) now reads `M/D`, `D/M`, `M/D/YYYY` (and two-digit years), ISO, "the 13th" (the agent's month, or the current one), "13th of November" and "Nov 13", including ranges.
- A numeric date valid both ways ("3/11") is ambiguous. If the agent logged one reading, the result is `disagrees` with `next_action: "wait_for_human"`, and the human gets "You wrote 3/11. Your agent read it as Mar 11. Did you mean Mar 11 or Nov 3? Reply 1 or 2." `corrected` is the reading the agent did not take, so `applyIntentCheck`'s simulated "their own words" answer picks it. If the agent's date matches neither reading, it is a plain disagreement (the month-first reading is put forward).
- Words with no date or budget (C1 has "Budget $1,500" but no date, so it still checks the budget and agrees) return `{ status: "absent", checkable: false }` and nothing is sent.
- **I changed your `tests/evals/live-intent.test.ts`** (one-off, approved by Karan, in PR #27) so main stays green: C2 with a logged Mar 11 2027 is now `disagrees`, `said: "3/11 (Mar 11 or Nov 3)"`, and the corrected intent is `2027-11-03` to `2027-11-06`. C1 stays `agrees`. Nothing else in your area was touched. The `evals/report.ts` line saying the parser reads only month names and ISO is out of date too. Rerunning the intent-check eval would give the real number.

### A2A transport ownership
Sarah owns A2A transport in both directions: inbound Proxy requests route to Dhwanil's hotel agent, and hotel replies route back to the orchestrator. If Inkbox inbound A2A does not work, use email between `proxy-agent` and `hotel-agent` with a structured JSON body. The protocol state machine is unchanged.

### From Karan: PR #6 merged (contract v2 checks passed)
- Checked: `logic` is typed as `Logic`, `plan_undo` has the v2 signature, the root rule is implemented, the airline has no agent, the transfer address is `support@metrotransfer.example`, merchants never refund, and `negotiate_step` reads only typed fields. 431 tests passed on the merge.
- FYI, no change needed: `trace` names chains `chain_<root action>`. When a late booking becomes the root (the flight confirmation arrives after the host email), the id changes. When I wire your Logic, the orchestrator will keep the existing chain id for a chain that shares actions with an open chain, so alerts and steps aren't orphaned.

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


### From Karan (2026-10-17)
- Your `logic` is wired in. `plan_undo` gets every action in the chain (it throws otherwise), and PICK filters the steps afterwards. Chain ids stay the same when the root changes, and settled actions stay in the chain so the widget keeps their green rows.
- `negotiate_step` drives the hotel live. `ignored_text` is counted in the events log, never stored. `ask_human` goes to the human, and Proxy stamps `sent_at` itself.
- `keep` steps are marked kept. Stripe disputes aren't wired yet, so `route: "stripe_dispute"` on keep is fine as it is.
- Added scripts: `npm run fixtures:demo`, `npm run evals:layer1`, and `npm run demo:hotel`, which runs Sarah's bridge as `hotel-agent` and answers through the server's `POST /merchants/hotel/agent`, so it uses the server's bookings.
- `/demo/host-email` now books the message with your host mock (ref `MSG-...`), so the correction email can name it.


### From Karan: QA pass on the live demo (2026-10-18)
1. **Airline after the 24-hour window:** `plan_undo` returns `route: "email_support", option: "change", cost: 7500`, but the airline has no support desk, so the step can only fail (`no_agent`). Proxy now tells the human "change it with the airline for a $75 fee". Please route this to something Proxy can do (a self-serve change with a fee?), or to `keep` with the fee, and tell me which.
2. **Hotel bookings live in the server's memory.** After a restart or a `/demo/reset` the hotel answers "Unknown booking reference" to an earlier run's request. That's fine for the demo, now that a reset closes earlier runs, but worth knowing.
3. `negotiate_step` returns `ignored_text`, which isn't in the `Logic` type. The orchestrator reads it if present and counts it in the events log. Say if you want it added to the contract.


### From Karan: "keep" route is in; push your airline change (2026-10-18)
- `RouteKind` now has `"keep"` (src/types.ts); the `get_chain` output schema accepts it, and the widget labels it "Kept". Switch `plan_undo`'s keep steps from `route: "stripe_dispute"` to `route: "keep"` whenever you like; the orchestrator treats `option: "keep"` or `route: "keep"` the same way.
- **Push your airline change (keep after the 24-hour window).** The final text is ready: a step the plan keeps is listed as still open, with the fee fix from `reversibility` ("Partly done. $0 of $412 back… Still open: Flight (change it with the airline for a $75 fee). Reply KEEP to accept the rest."), and the chain ends `partial`, not `redo_requested`. `src/orchestrator/workflows.test.ts` test 10b checks exactly that, by making your `plan_undo` return keep for the airline. Test 10 accepts either your current plan or the keep step.
- `scripts/hotel-agent.ts` now prints your `narrateExchange(…, { style: "speakers", merchant: "Hotel" })` lines. Its polling backs off on Inkbox 429s (at most one poll every 3 s, honoring retry_after_seconds).


### From Karan: log_intent takes the human's own words (original_request) (2026-10-18)
- `LogIntentInput.original_request?: string`. Proxy reads dates and a budget from it with a deterministic parser (`src/orchestrator/intent-words.ts`, no model) and compares them with `constraints`. On a disagreement it texts the human "Your agent understood <X>. You said <Y>. Reply 1 for <Y> or 2 for <X>." and `log_intent` returns `next_action: "wait_for_human"` with `intent_check { status: "disagrees", understood, said }`. Calling `log_intent` again with the same key returns `confirmed_human` (plus the corrected `constraints`) or `confirmed_agent`. On agreement it sends nothing.
- This is your S34 case (the agent logs the wrong intent, so `compare` agrees with it): when the agent passes the human's words, Proxy now catches it before anything is booked. If you add a scenario for it, the expected result is "caught at log_intent, by asking the human"; scenarios without `original_request` behave as before.
- Only fields the human actually mentioned count (a request with no budget never disagrees on budget), and a start date alone keeps the trip's length.

## Karan's Codex

### trip-dmy scenario in src/agent (Karan, 2026-10-18)
- scenarios.ts: new runTripDmyAgent and DMY_REQUEST; SCENARIO_NAMES has "trip-dmy". It books Nov 3 without waiting and ends its session with `late: false`.
- scripted.ts: DemoControl.endSession takes `{ late?: boolean }`; `late: false` sends `late=0`, so the demo clock stays on the agent's day.
- human-phase.ts: optional `dateAnswer` (step date_answer, before the alert) and `expectRedo`. rehearse.ts leaves date_answer out of the trip's step list.

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

### From Karan (2026-10-17)
- The rehearsal could add a last step: after the late confirmations, wait about 2 s, `POST /web/reply {"chain_id", "kind":"undo_all"}`, and poll `get_chain` until `next_action` is `redo`. I ran it by hand on port 3001: the chain ended `redo_requested`, with flight, hotel (85%) and transfer verified in Stripe.
- Repeated runs against a fresh memory store reuse the same Stripe charges (same task id, so the same idempotency keys). Proxy then reports "already refunded", which is correct but sends no new refund. Consider adding the run time to the charge idempotency key.
