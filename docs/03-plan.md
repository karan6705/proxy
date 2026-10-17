# Proxy — Plan

**What we're building:** the undo layer for AI agents. Proxy gives each task its own email address, captures every receipt and Stripe charge, compares them with the intent, traces the whole chain of things one mistake broke, texts the human once, undoes the chain (negotiating agent to agent with merchant agents over Inkbox where it can), confirms the money in Stripe, and hands the corrected intent back to the original agent to redo it right.

**Read first:** `01-concepts.md`, then this file. `02-team-plan.md` is the one-page version. `04-architecture.md` is how it's built. `05-demo-flow.md` is what we do on stage. `06-build-steps.md` is the ordered checklist.

**Time:** hacking starts Sat Oct 17, 10:30 AM. Submissions are due Sun Oct 18, 10 AM. About 23.5 hours. Contracts freeze Sat 12:30 PM. **This is the final plan. No more idea changes.** We are three people, each working with a coding agent.

## How to use this file

- Find your name. Those are your jobs. Tick the box (`[x]`) when done.
- Checkpoints are go/no-go gates. If a gate fails, use its fallback and move on.

## Who owns what

| Person | Owns |
|---|---|
| **Karan (lead)** | Scaffold, `src/types.ts`, the MCP server (six tools, the `mistakes` resource, error contract, idempotency), the MCP App (live chain), Stripe (charges, refunds, disputes, webhook, verification), the undo orchestrator (timers, rounds, route fallthrough, redo), demo buying-agent client and scripted agent mode, Manufact deploy, submission |
| **Sarah** | Everything Inkbox: task inboxes and the inbound email webhook, capture and extraction (JSON-LD first, LLM fallback) into Actions, alert texts and the escalation SMS, iMessage, phone, the UNDO ALL / PICK / KEEP handler, A2A transport and email fallback for the Reversal Protocol, support emails with follow-ups, Supabase tables, append-only log, live demo page |
| **Dhwanil** | The brain in `src/logic/`: `compare`, `trace`, `reversibility`, `plan_undo` (damage minimizer), `rank`, `negotiate_step`; the mock merchants and merchant agents in `src/merchants/`; the simulated clock; fixtures; the naive arm; ~30 scenarios; the grader; eval runs; the scoreboard page; the `mistakes` lessons content |

## What we're going for

- **Manufact (main):** the best MCP server for agents. Six tight tools, a resource, an MCP App, `retryable` and `next_action` on errors, idempotent calls. One server works with every agent in every client.
- **Inkbox (main):** every channel has a real job: email (task addresses, support emails), SMS and iMessage (alerts and UNDO), phone (escalation), A2A (the Reversal Protocol).
- **The demo moment:** one text, UNDO ALL, and the live chain turns green as the flight, hotel, transfer and email are fixed, with the hotel's agent negotiated with on screen and every row confirmed in Stripe.

## Priorities

1. **Core, capture and detect:** `log_intent`, task inbox, extraction, Stripe events, `compare`, `review`, `trace` into chains.
2. **Core, tell and undo:** the one-text alert with UNDO ALL / PICK / KEEP, `reversibility`, `plan_undo`, at least one A2A negotiation, email-support fallback, Stripe-verified refunds, redo.
3. **Core, proof:** append-only log, scenarios, grader, scoreboard, the MCP App.
4. **If time allows:** iMessage and phone escalation, damage minimizer polish, `mistakes` resource polish, LLM extraction for messy emails.
5. **Stretch:** real receipt emails, more merchant agents.

## Phases

### Phase 0: Tonight

- [ ] **Karan:** deploy the mcp-use TypeScript template to Manufact Cloud and confirm the public URL answers. Confirm how to ship an MCP App with mcp-use. Get Stripe test keys.
- [ ] **Sarah:** get an Inkbox API key. Verify, in this order: send and receive email, can you create many task addresses (or does plus-addressing work), inbound and outbound text, iMessage, outbound phone calls, A2A between two identities. Write down what is and isn't available. The fallbacks are in the phases below.
- [ ] **Sarah:** create the Supabase project.
- [ ] **Dhwanil:** list the ~30 scenarios (mix in `04-architecture.md`) and the scenario format: a scripted sequence of tool calls, emails and Stripe events with seeded times, and the expected result.
- [ ] **Dhwanil:** verify the real-world rules behind the reversibility table and every claim listed under "Claims to verify before the pitch" in `01-concepts.md`.
- [ ] **Everyone:** make sure your coding-agent and Claude API keys work.
- [ ] **At kickoff, Karan:** ask the organizers: can one project enter multiple tracks? Is pre-existing code allowed? How long is the demo slot?

### Phase 1: Set up (Sat, 10:30 AM to 12:30 PM)

- [ ] **All three:** lock the seven contracts in `04-architecture.md` and the parameters listed under them. Agree the demo scenario's exact amounts and times (flight $412, hotel $640, transfer $188, host email, $1,240 at risk, 3h 40m left).
- [ ] **Karan:** commit `src/types.ts`. Server runs locally with stub tools in the mcp-use Inspector.
- [ ] **Sarah:** create the Supabase tables (`intents`, `actions`, `chains`, `steps`, `lessons`, `events`). Set up Inkbox identities: Proxy, a merchant-support inbox, and two merchant-agent identities (airline, hotel).
- [ ] **Dhwanil:** the simulated clock and the stub scenario runner that can target either arm.

### Phase 2: Capture works (Sat, 12:30 PM to 2 PM)

- [ ] **Karan:** `log_intent` (returns the task address) and `review` wired to `compare`. Stripe wrapper: test charge, refund, and a webhook that records events.
- [ ] **Sarah:** inbound email webhook on the task address, JSON-LD extraction into Actions, log every event.
- [ ] **Dhwanil:** `compare` with unit tests first. The airline and hotel mock merchants: a booking endpoint that charges Stripe test mode and emails a JSON-LD confirmation to the task address.
- [ ] **Checkpoint 2 PM:** `log_intent` returns an address, a mock merchant books with the wrong date, the confirmation arrives and becomes an Action, the Stripe charge is seen, and `review` returns the mismatch.
  - **Fallback:** if unique task addresses aren't possible, use plus-addressing or the task id in the subject. If inbound email is unreliable, the mock merchant posts the confirmation straight to the webhook and we say so.

### Phase 3: The chain, the text, the first undo (Sat, 2 PM to 6 PM)

Dinner is at 5 PM. Plan around it.

- [ ] **Dhwanil:** `trace` (root plus dependents), `reversibility`, `plan_undo`, `rank`. Transfer and host-email mock merchants. Fixtures for the demo scenario and a clean task.
- [ ] **Sarah:** alert text with the countdown, and the UNDO ALL / PICK / KEEP inbound handler (only the human's number). Result texts.
- [ ] **Karan:** the orchestrator with one route end to end: the airline's 24-hour rule through the merchant simulator, then Stripe refund and verification. `get_chain`, `undo`, `list_chains`.
- [ ] **Karan:** demo buying-agent client (Claude connected to the remote MCP URL, or our own tool loop).
- [ ] **Dhwanil:** start the ~30 scenarios and the grader. Smoke eval: about 10 scenarios, both arms, both layers.
- [ ] **Checkpoint 6 PM:** the wrong-date trip creates one chain of four actions, the text arrives, UNDO ALL is replied, the flight refunds and Stripe verifies it, and the result text arrives. Smoke eval has run.
  - **Fallback:** if inbound text is unreliable, demo page buttons stand in for UNDO ALL / PICK / KEEP. Stop debugging at 6 PM.

### Phase 4: Agent to agent, the rest of the chain, the scoreboard (Sat, 6 PM to midnight)

- [ ] **Sarah:** the Reversal Protocol transport: A2A between Proxy and the hotel agent, with the email fallback carrying the same JSON. Support emails with follow-ups for merchants with no agent. Escalation: iMessage, then phone call. Harden: UNDO sent twice, a reply from the wrong number, a reply after the window closes.
- [ ] **Dhwanil:** `negotiate_step` and the hotel merchant agent (accept, counter, deny behaviors). Damage minimizer. SaaS and store merchants. All ~30 scenarios. Layer 1 on both arms. Layer 2 with a real agent. The scoreboard page.
- [ ] **Karan:** orchestrator routes for the hotel (protocol), transfer (email support), and host (correction message). Redo: corrected intent back to the original agent and verification with `compare`. The MCP App (live chain, green only when Stripe verifies). Deploy to Manufact Cloud and test there.
- [ ] **Checkpoint midnight:** the full demo chain reverses: flight by rule, hotel by negotiation (counter, push back, accept), transfer by email, host corrected, each verified in Stripe, then redone correctly. The MCP App shows it. First full scoreboard run is done.
  - **Fallback:** if A2A isn't available, the protocol runs over email with the same JSON and state machine. If email replies are unreliable, a demo page button posts the merchant reply, and the backup video shows the real moment. Cut the phone call first.

### Phase 5: Finish (Sunday)

- [ ] **2 AM, feature freeze:** bug fixes only.
- [ ] **Dhwanil:** final scoreboard run (both layers). Save raw event logs.
- [ ] **Karan:** record a backup video of the full undo.
- [ ] **Sarah:** phone and inboxes ready for the live run. Test the iMessage and call path once on the real phone.
- [ ] **8 AM, rehearsal:** all three practice the full demo twice, with a timer (`05-demo-flow.md`).
- [ ] **Karan:** submit before the Sun 10 AM deadline.

## If we run behind

Drop in this order. Never drop `log_intent` with the task inbox, `review`, chain tracing, the one-text alert with UNDO ALL, at least one A2A (or protocol-over-email) negotiation, Stripe-verified refunds, redo, or the scoreboard.

1. Phone call, then iMessage (keep SMS, plus the demo page buttons).
2. Layer 2, the live-agent eval.
3. LLM extraction for messy emails (use JSON-LD only).
4. SaaS and store merchants.
5. Damage minimizer polish and `mistakes` resource polish.

## Risks

| Risk | Likelihood | What we do |
|---|---|---|
| Inkbox doesn't offer what the design assumes (unique addresses, A2A, iMessage, calls) | Medium | Verify tonight. Fallbacks are listed in each phase. Say what we really used |
| Scope: capture, brain, alerts, protocol, MCP App, five merchants | High | Phase 3 delivers one full undo first. The cut list above. Each person has a coding agent |
| Real reversals aren't real | High | The merchants and merchant agents are our mocks, and we say so on stage |
| The research and competitor claims are wrong | Medium | Verify before the pitch. Unverified claims stay out |
| Windows are hours long | Medium | Simulated clock with seeded booking times. Say so on stage |
| Agent negotiation loops or gets injected | Medium | State machine: fixed steps, three rounds, hard deadline. Merchant messages are untrusted |
| Inbound text or email unreliable on stage | Medium | Demo page buttons as fallback. Backup video |
| Extraction from emails is wrong | Medium | JSON-LD first. Money is checked in Stripe, not in the message |
| Called "just rules" | Medium | Show the scored eval against the naive arm and the live chain |
| Scoreboard looks faked | Medium | Real runs only, raw logs saved |
| Contract drift between three people | Medium | Freeze Sat 12:30 PM |
| Overclaiming | Medium | See "What Proxy does not stop" in `01-concepts.md` |
| Pre-existing code or multi-track rules | Low | Ask organizers at kickoff |

## Success criteria

- The demo mistake is caught and traced as one chain, and the human gets one text.
- UNDO ALL reverses the chain live, including a negotiation with the hotel's agent, and each row turns green only when Stripe verifies it.
- The correct booking is redone and verified against the intent.
- The scoreboard is from real runs, with raw logs saved.
- Everyone can explain what Proxy does and what it does not stop.
