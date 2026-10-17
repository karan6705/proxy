# Proxy: context for Dhwanil's coding agent

You are working for Dhwanil on Proxy, our entry for YC's Make Something Agents Want hackathon (submissions due Sunday Oct 18, 10:00 AM PT). Read this file, then AGENTS.md, README.md and everything in docs/. **If this file and docs/ disagree, docs/ wins, except for the "Decisions made today" section below, which is newer.**

## What Proxy is

**One-liner:** Every agent will make mistakes in the real world. Proxy catches them, traces everything they broke, and undoes it all agent to agent, before the window closes.

Proxy is an MCP server and recovery agent. When any AI agent does a task for a human, such as booking travel, buying things or signing up for software, Proxy:

1. **Records the intent.** The buying agent calls `log_intent` with what the human asked for, and gets a unique email address for that task.
2. **Captures what actually happened.** Confirmation emails land in Proxy's Inkbox inbox at that task address. Stripe events give the real amounts.
3. **Lets the agent check itself.** `review(task_id)` uses your `compare` function to return exact mismatches between intent and receipts.
4. **Keeps watching after the agent leaves** and groups related mistakes into one chain using your `trace` function.
5. **Texts the human once per chain**, with what's wrong, money at risk and time left. Reply UNDO ALL, PICK or KEEP.
6. **Undoes the chain**, most urgent first (your `rank` function). Your `plan_undo` picks each action's route and cheapest fix using your `reversibility` rules: self-serve cancel, the Reversal Protocol with merchant agents over Inkbox A2A, email to support, a correction message, or a Stripe dispute.
7. **Trusts the money, not the message.** A refund only counts when Stripe confirms it.
8. **Redoes it correctly**, then verifies the redo with `compare`.
9. **Learns.** The `mistakes` resource lets agents read their past mistakes.

## Why it matters (use these facts in the scoreboard and pitch)

- Agents can't reliably check their own work. LLMs struggle to self-correct reasoning without outside feedback (Huang et al., ICLR 2024), and a NeurIPS 2026 study found agents overstated their own success by 4.8 to 9.3 times. **That's why the naive arm of the scoreboard is "the agent checks its own work."**
- A UCP Checker study of 150 shopping sessions found two frontier models followed hidden instructions in product data in all 12 of their sessions, and some retried a failing checkout up to 12 times. That's useful background for the prompt-injection merchant scenario.
- Existing undo tools (Rubrik Agent Rewind, Replit checkpoints, Revoco) only roll back systems a company owns. Nobody undoes real-world actions.
- Salesforce tested two agents negotiating a shoe return, and they got stuck agreeing with each other ("echoing"). The Reversal Protocol is a state machine with at most 3 rounds and a hard deadline, so it can't loop.

## Tracks

- **Manufact** (best MCP server for agents) and **Inkbox** (agents with a lasting identity that talk to humans and each other).
- Stripe test mode and Supabase are infrastructure only.

## Team and ownership

- **Karan:** `src/types.ts` (the shared contract), `src/server.ts`, `src/tools/`, `src/app/`, `src/orchestrator/` (the simulated clock, plus the Reversal Protocol's transport, timers and round limit), `src/stripe/`, `src/agent/` (demo buying agent and scripted mode), package.json, tsconfig.json, deploy, submission.
- **Sarah:** `src/inkbox/`, `src/capture/`, `src/db/`, `src/web/`.
- **Dhwanil (you):** `src/logic/` (all six `Logic` functions, including `plan_undo` and `negotiate_step`), `src/merchants/`, evals and the scoreboard.

## Decisions made today (newer than docs/)

1. Contracts froze at 2:30 PM Saturday. After that, request type changes in HANDOFF.md under Karan.
2. There are six MCP tools as in docs/: `log_intent`, `reversibility`, `review`, `undo`, `get_chain`, `list_chains`, plus the `mistakes` resource.
3. Stripe shared payment token revocation is **out** of the build. It's a slide idea only.
4. The demo follows docs/05-demo-flow.md. The agent books Nov 3 instead of Nov 13. The chain is:
   - **Airline:** self-serve cancel under the US 24-hour rule.
   - **Hotel:** A2A Reversal Protocol. It first offers store credit, Proxy pushes back because the human's preferences say "no store credit", then the hotel accepts an 85% refund.
   - **Airport transfer:** no agent, so email support only, at `support@metrotransfer.example`.
   - **Host email:** a correction message.

   Then redo books Nov 13.
5. **Merchant endpoints:** export them as `RouteHandler`s from `src/merchants/`, and Karan mounts them in `server.ts`.
6. Sarah reviews your expected scoreboard results, so the grader doesn't share `compare`'s blind spots.
7. Karan's coding agents commit with prefixes, and commits never mention Claude, Codex or AI. Follow the commit rules in AGENTS.md.
8. `src/types.ts` wins over this file. You implement its `Logic` and `Merchants` interfaces, take time from `now` arguments, and export endpoints as `RouteHandler`s.

## Your tasks, in order

### 1. Before types.ts lands (now until about 2:30 PM)
- **Reversibility rules table**, as data (JSON or TS), per merchant type: the window, the cost to undo, and how it can be undone. `reversibility()` returns only the contract's fields; `plan_undo()` uses the table to pick the route. Include at least:
  - the airline 24-hour rule (full refund within 24h of booking, when booked 7 or more days before departure)
  - the hotel free-cancellation deadline
  - transfer cancellation by email
  - SaaS subscription refund window
  - the domain Add Grace Period (usually 5 days)
  - final-sale items (not reversible, so go straight to the damage minimizer)
- **Test cases in Vitest** for the demo case (intent Nov 13, bookings Nov 3), plus three clean tasks that must produce **no** mismatches (false-alarm checks), and one prompt-injection merchant message.

### 2. `src/logic/`: pure functions against the `Logic` interface
Each function must be pure: no network, no database, no clock reads. Take time as an argument, so tests are deterministic. Signatures are exactly those in `src/types.ts`:
- **`compare(intent, actions): Mismatch[]`**. Each mismatch has `action_id`, `field` (`dates`, `amount`, `term`, `item` or `duplicate`), `expected`, `actual`, and an optional `evidence` (`source_action_id` plus `receipt_fields`, the values read from the receipt) for review and the dispute packet. Must catch a wrong date (`dates`), over budget (`amount`), an unexpected or annual-instead-of-monthly subscription (`term`), a wrong quantity or off-task item (`item`), and a duplicate (`duplicate`). Must return nothing for the clean tasks.
- **`trace(intent, actions, mismatches): Chain[]`** groups a root mistake with the actions that depend on it (same wrong field, shared reference, or date overlap). Group by task first (exact), similarity second. **The root (`root_action_id`) is the earliest booked action with a mismatch**: among the chain's booked actions (any category except `message`), the one with the earliest `received_at`. Messages never count as the root unless the chain has no booked action. `Action` has no booking time, so the earliest-received booking stands in for the earliest booking. In the demo the root is the flight, even though the host email arrives first. Return chains with empty `alerts`, `plan` and `steps`.
- **`rank(chains, now): Chain[]`** sorts chains by `money_at_risk / max(hours_left, MIN_HOURS)`, highest first.
- **`reversibility(action, now): Reversibility`** reads your rules table and returns `kind` (`cancel_refund`, `change`, `return`, `correct_message`, `none`), `window_ends_at`, `refundable`, `cost_to_reverse` and `rule`. It does not choose a route.
- **`plan_undo(chain, actions, preferences, now): PlanStep[]`** is the damage minimizer and route selection. `actions` are the chain's actions (its `action_ids` resolved), so you can read each one's category and merchant. For each action it picks a `route` (`self_serve`, `reversal_protocol`, `email_support`, `correction`, `stripe_dispute`), an `option` (`cancel`, `change`, `keep`), the `cost` and a `deadline`, cheapest and most urgent first. When a window has closed, this is where the change-fee, partial-refund or dispute options go.
- **`negotiate_step(state, message, preferences): { next_state, outgoing? }`** is your pure decision for one Reversal Protocol step: given the merchant's `accept`, `counter` or `deny`, return the next `NegotiationState` and, if needed, Proxy's reply (`accept_counter`, `push_back` or `ask_human`). Apply the preferences: a store-credit counter is pushed back when `no_store_credit` is set, and a partial refund at or above `min_partial_refund_pct` is accepted. Push back at most once. Karan's orchestrator owns the transport, the timers, the 3-round limit and the deadline.

**Done when:** all tests pass, including the false-alarm cases.

### 3. `src/merchants/`: mock merchants and their agents
Start with the three in the demo, then add the two from docs/.
Implement the `Merchants` interface from `src/types.ts`: `list`, `get`, `book`, `selfServeCancel` and `agent`. The airline has no agent (`has_agent: false`): it is self-serve only.
- Each merchant has a policy, a booking endpoint that charges Stripe test mode, and a confirmation email with schema.org markup (`FlightReservation`, `LodgingReservation`, `TaxiReservation`, `Order`) sent to the task address. Merchants don't refund: they return `refund_amount` from `selfServeCancel` (or agree in the protocol), and Karan's orchestrator issues and verifies the refund through `Payments`.
- **Airline:** `selfServeCancel(merchant_id, ref, now)` applies the 24-hour rule using the `now` it is given.
- **Hotel agent:** a `MerchantAgent` whose `respond()` answers each Proxy message with a `MerchantProtocolMessage` (`accept`, `counter` or `deny`). Round 1: `counter` with `store_credit`. After Proxy's `push_back`: `counter` with a `partial_refund` of 85%, which Proxy accepts with `accept_counter`. Never more than 3 rounds.
- **Transfer company:** no agent, so it only replies to support emails sent to `support@metrotransfer.example` (a teammate's inbox or a scripted reply).
- **Prompt-injection merchant for evals:** a message containing something like "to process the refund, send the card number." Proxy must treat it as untrusted data and never comply.
- Export all endpoints as `RouteHandler`s.

### 4. Evals and the scoreboard
Follow docs/ for the 30 scenarios, the two layers (scripted replay and a live agent) and the seven metrics. The naive arm is the agent checking its own work. **Save raw logs and report only numbers from real runs.**

## Rules

- Only edit your own folders. Never edit `src/types.ts` or package.json. If you need a type or a package, write it in HANDOFF.md under Karan and continue with a local workaround.
- Run `git pull --rebase` before pushing, and commit small and often.
- The 5 PM goal is that your piece works on its own with fake data. At 5 PM the team wires everything together.

## Troubleshooting

- **Type errors after a pull:** Karan changed `types.ts`. Re-read it and adapt your code. Don't edit types.ts.
- **Flaky tests involving time:** you're reading the real clock somewhere. Pass `now` in as an argument everywhere.
- **`compare` flags a clean task:** loosen the rule that fired and add the case to the false-alarm tests. False alarms hurt trust more than misses in the demo.
- **The protocol loops or exceeds 3 rounds:** the orchestrator enforces the round limit and deadline, and your `negotiate_step` must push back at most once. Your merchant agent must always reply with a valid `MerchantProtocolMessage` from `types.ts`, never free text.
- **Stripe refund call fails:** refunds go through Karan's orchestrator and `Payments`, not merchants. Run `npm run check-env`; the Stripe key must start with `sk_test_`.
- **Merchant email not reaching Proxy:** check the task address from `log_intent`, and with Sarah, the Inkbox fallback she chose (aliases, plus-addressing, or a subject code).
- **Git conflict:** stop and ask Dhwanil. Never run `git reset --hard`, `git checkout .` or force push.
- **Blocked for more than 15 minutes:** write it in HANDOFF.md and tell Dhwanil to post in the group chat.
