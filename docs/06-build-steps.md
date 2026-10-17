# Proxy — Final Build Steps

Three people, each working with a coding agent. Two tracks: **Manufact** (best MCP server) and **Inkbox** (agent identity). Stack: TypeScript, Node 18+, mcp-use, `@inkbox/sdk`, Stripe test mode, Supabase, Anthropic SDK.

Hacking starts Sat Oct 17, 10:30 AM. Submit before Sun Oct 18, 10 AM. Contracts freeze at 12:30 PM Saturday. **This is the final plan.**

**What we're building:** the undo layer for AI agents. Each task gets its own email address. Proxy captures receipts and Stripe charges, compares them with the intent, traces the chain one mistake broke, texts the human once, undoes the chain (agent to agent where possible), verifies the money in Stripe, and has the original agent redo it correctly.

## Who owns what

| Person | Owns (folders) |
|---|---|
| **Karan (lead)** | `src/server.ts`, `src/tools/` (six tools, `mistakes` resource), `src/app/` (MCP App), `src/stripe/`, `src/orchestrator/` (undo routes, timers, rounds, redo), `src/types.ts`, `package.json`, `tsconfig.json`; the demo buying-agent client and scripted agent mode; Manufact deploy; submission |
| **Sarah** | `src/inkbox/` (email, SMS, iMessage, phone, A2A), `src/capture/` (inbound webhook, JSON-LD and LLM extraction into Actions), `src/db/` (Supabase tables, append-only log), `src/web/` (live demo page) |
| **Dhwanil** | `src/logic/` (`compare`, `trace`, `reversibility`, `plan_undo`, `rank`, `negotiate_step`), `src/merchants/` (mock merchants and merchant agents), the simulated clock, `evals/`, `fixtures/`, `tests/` |

Rules from `AGENTS.md` apply: small commits with explicit paths (`git add src/logic/...`), `[core]` prefix for `src/`, `[evals]` prefix for `evals/`, `fixtures/` and `tests/`. No `git add .`, no force push, `git pull --rebase` before pushing. Secrets only in `.env`; every name goes in `.env.example`. Only Karan edits `package.json`; others ask in `HANDOFF.md`. Short-lived branches (`karan/...`, `sarah/...`, `dhwanil/...`), merge to `main` often, and `main` must always run.

## Priorities

1. **Capture and detect:** `log_intent`, task inbox, extraction, Stripe events, `compare`, `review`, `trace`.
2. **Tell and undo:** one-text alert with UNDO ALL / PICK / KEEP, `reversibility`, `plan_undo`, at least one agent-to-agent negotiation, email-support fallback, Stripe-verified refunds, redo.
3. **Proof:** append-only log, scenarios, grader, scoreboard, MCP App.
4. **If time allows:** iMessage and phone escalation, damage minimizer polish, `mistakes` resource polish, LLM extraction.
5. **Stretch:** real receipt emails, more merchant agents.

If behind, cut: phone then iMessage, then Layer 2, then LLM extraction, then SaaS and store merchants, then damage minimizer polish. Never cut `log_intent` with the task inbox, `review`, chain tracing, the one-text alert, at least one negotiation, Stripe-verified refunds, redo, or the scoreboard.

---

## Step 0: Prep (tonight)

**Karan**
- [ ] Scaffold with `npx create-mcp-use-app@latest`. Deploy with `mcp-use deploy` and confirm the public URL answers.
- [ ] Confirm how to ship an MCP App (widget) with mcp-use.
- [ ] Stripe test-mode keys.
- [ ] At kickoff, ask the organizers: multiple tracks? pre-existing code? demo slot length?

**Sarah**
- [ ] Inkbox API key. Read the TypeScript SDK docs.
- [ ] Verify and write down what is available: email send and receive, many task addresses (or plus-addressing), inbound and outbound text, iMessage, outbound phone calls, A2A between two identities.
- [ ] Create the Supabase project.

**Dhwanil**
- [ ] List the ~30 scenarios using the mix in `04-architecture.md`, and the scenario format (scripted tool calls, emails and Stripe events with seeded times, plus the expected result).
- [ ] Verify the real-world rules behind the reversibility table and every item under "Claims to verify before the pitch" in `01-concepts.md`.

**Done when:** the template server answers, Sarah's availability notes exist, and the scenario list exists.

## Step 1: Freeze contracts (Sat 10:30 AM to 12:30 PM)

**All three, together:** lock seven things. After 12:30 PM, changes need all three to agree.
1. Tool schemas: `log_intent`, `reversibility`, `review`, `undo`, `get_chain`, `list_chains`, and the `mistakes` resource.
2. Error contract: `{ok, code, message, retryable, next_action}`.
3. Core objects: Intent, Action, Mismatch, Chain, Reversibility.
4. Pure function signatures: `compare`, `trace`, `reversibility`, `plan_undo`, `rank`, `negotiate_step`.
5. Reversal Protocol messages and states.
6. Mock merchant interface: booking endpoint, JSON-LD confirmation format, reversal rules, merchant agent hook.
7. `events` row.

Also set: `MIN_HOURS`, `REPLY_WAIT`, `CALL_AT`, `AUTO_UNDO_AT`, `FOLLOW_UP_EVERY`, `PROTOCOL_DEADLINE`, `CLOCK_SCALE`, the reversibility values per merchant, default preferences, the alert text, and the demo scenario's amounts and times (flight $412, hotel $640, transfer $188, host email, $1,240, 3h 40m).

**Karan**
- [ ] Commit `src/types.ts` with the contracts.
- [ ] Server runs locally with stub tools in the mcp-use Inspector.

**Sarah**
- [ ] Supabase tables: `intents`, `actions`, `chains`, `steps`, `lessons`, `events` (no update or delete on `events`).
- [ ] Inkbox identities: Proxy, merchant support, hotel agent (the airline has no agent).

**Dhwanil**
- [ ] The simulated clock and the stub scenario runner that can target either arm (`naive` or `proxy`).

**Done when:** `src/types.ts` is committed, all three agree, and the stub server runs.

## Step 2: Capture works (Sat 12:30 PM to 2 PM)

**Karan**
- [ ] `log_intent`: creates the intent and the task address, idempotent.
- [ ] `review`: calls `compare` on the task's actions.
- [ ] Stripe wrapper: test charge, refund, dispute, and a webhook that records events. A function that verifies a refund.
- [ ] Error contract on every tool. Tool descriptions written for agents (what it does, when to call it, what to do next). Compact JSON.

**Sarah**
- [ ] Inbound email webhook on the task address.
- [ ] Extract JSON-LD into Actions, dedupe by reference.
- [ ] Log every inbound and outbound event to `events`.

**Dhwanil**
- [ ] `compare` with unit tests first (`tests/`): wrong date, amount over budget, wrong term, wrong item, duplicate.
- [ ] Airline and hotel mock merchants: a booking endpoint that charges Stripe test mode and emails a JSON-LD confirmation to the task address.

**Checkpoint 2 PM:** `log_intent` returns an address, a mock merchant books with the wrong date, the confirmation becomes an Action, the Stripe charge is seen, and `review` returns the mismatch.
**Fallbacks:** plus-addressing or the task id in the subject if unique addresses aren't possible. The mock merchant posts straight to the webhook if inbound email is unreliable (and we say so).

## Step 3: The chain, the text, the first undo (Sat 2 PM to 6 PM)

Dinner is at 5 PM.

**Dhwanil**
- [ ] `trace`: root mistake plus dependents (same wrong field, shared reference, date overlap).
- [ ] `reversibility`, `plan_undo` (ordered by urgency and cost), `rank`.
- [ ] Transfer and host-email mock merchants. Fixtures for the demo scenario and for a clean task.
- [ ] Start the ~30 scenarios and the grader. Smoke eval: about 10 scenarios, both arms, both layers.

**Sarah**
- [ ] Alert text with the countdown when a chain opens.
- [ ] UNDO ALL / PICK / KEEP inbound handler (only the human's number). Result texts.

**Karan**
- [ ] Orchestrator, first route end to end: the airline's 24-hour rule through the merchant simulator, then Stripe refund and verification.
- [ ] `undo`, `get_chain`, `list_chains`.
- [ ] Demo buying-agent client (Claude connected to the remote MCP URL, or our own tool loop).

**Checkpoint 6 PM:** the wrong-date trip creates one chain of four actions, the text arrives, UNDO ALL is replied, the flight refunds and Stripe verifies it, and the result text arrives. Smoke eval has run.
**Fallback:** demo page buttons stand in for UNDO ALL / PICK / KEEP if inbound text is unreliable. Stop debugging at 6 PM.

## Step 4: Agent to agent, the rest of the chain, the scoreboard (Sat 6 PM to midnight)

**Sarah**
- [ ] Reversal Protocol transport: A2A between Proxy and the hotel agent, with the email fallback carrying the same JSON.
- [ ] Support emails with follow-ups for merchants with no agent (the transfer service).
- [ ] Escalation: iMessage, then phone call. Reminders as the window shrinks.
- [ ] Harden: UNDO sent twice, a reply from the wrong number, a reply after the window closes, a duplicate confirmation email.

**Dhwanil**
- [ ] `negotiate_step` and the hotel merchant agent (accept, counter, deny).
- [ ] Damage minimizer in `plan_undo`.
- [ ] SaaS and store merchants.
- [ ] All ~30 scenarios. Layer 1 (scripted eval) on both arms. Layer 2 (live agent) on the same tasks, reporting what happens.
- [ ] Save results to a file the scoreboard page reads.
- [ ] Scoreboard page: mistakes caught (self-review vs Proxy) and false alarms, chain completeness, money recovered and chains fixed in time, redo correct, false "done" claims, time to alert, tokens per task (headline). State that the naive arm has no capture or undo.
- [ ] Fix any rules the runs show are wrong.

**Karan**
- [ ] Orchestrator routes: hotel (protocol with rounds and deadline), transfer (email support), host (correction message).
- [ ] Redo: corrected intent back to the original agent, then verify with `compare`.
- [ ] MCP App: the live chain, each row green only when Stripe verifies the refund.
- [ ] Scripted agent mode so the wrong-date booking and the late confirmation fire reliably.
- [ ] Deploy to Manufact Cloud and test there end to end.

**Checkpoint midnight:** the full demo chain reverses: flight by rule, hotel by negotiation (counter, push back, accept), transfer by email, host corrected, each verified in Stripe, then redone correctly. The MCP App shows it. First full scoreboard run is done.
**Fallbacks:** if A2A isn't available, run the protocol over email with the same JSON and state machine. If email replies are unreliable, post the merchant reply from a demo page button, and the backup video shows the real moment. Cut the phone call first.

## Step 5: Freeze, final run, rehearsal (Sunday)

**Everyone**
- [ ] **2 AM feature freeze.** Bug fixes only.
- [ ] **8 AM rehearsal:** full demo twice with a timer. Write down the exact agent tasks, the seeded times and the exact merchant replies.

**Karan**
- [ ] Record a backup video of the full undo.
- [ ] Reset the demo task, preferences and clock. Confirm Stripe is in test mode and the Manufact URL answers.
- [ ] Test the MCP server in Claude Code, Codex and Cursor. Only claim the ones that worked.
- [ ] Submit before Sun 10 AM.

**Sarah**
- [ ] Phone and inboxes ready for the live run. Test the iMessage and call path once on the real phone.
- [ ] Final bug fixes on capture, texts and the demo page.

**Dhwanil**
- [ ] Final scoreboard run, both layers. Save the raw event logs. Report only real numbers.
- [ ] Screenshot the scoreboard. Write the scoreboard line in `05-demo-flow.md` step 6 from what the numbers show.
- [ ] Remove or soften any pitch claim in `01-concepts.md` that wasn't verified.

---

## Final ship checklist

- [ ] `log_intent` returns a task address, and bookings sent to it become Actions.
- [ ] `review` returns exact mismatches against the intent.
- [ ] A late confirmation after the agent is gone joins the right chain.
- [ ] One text per chain arrives, and UNDO ALL, PICK and KEEP all work.
- [ ] The flight reverses by rule, the transfer by email, the host gets a correction, and the hotel by negotiation with the hotel agent.
- [ ] Every refund is verified in Stripe before its row turns green.
- [ ] The corrected intent is redone and `review` finds no mismatch.
- [ ] The `mistakes` resource lists the lesson.
- [ ] The MCP App shows the live chain.
- [ ] Scoreboard comes from real runs, raw logs saved.
- [ ] Server live on Manufact Cloud.
- [ ] No secrets committed; `.env.example` lists every variable.
- [ ] README explains what it is, how to run it, and the limits: mock merchants and agents, simulated clock, some mistakes can't be undone, Proxy only sees what reaches the task address and Stripe.
- [ ] All three can explain what Proxy does and does not stop.
