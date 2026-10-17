# Proxy — Team Plan (one page)

Details live in `03-plan.md`. This is the short version.

## What we're building

The undo layer for AI agents. Every agent will make mistakes in the real world. Proxy gives each task its own email address, captures every receipt and Stripe charge, compares them with the intent, traces the whole chain one mistake broke, texts the human once, and undoes the chain before the window closes. It negotiates agent to agent with merchant agents over Inkbox, confirms the money in Stripe, then hands the corrected intent back to the original agent to redo it right.

Tracks: **Manufact** (MCP server) and **Inkbox** (agent identity). Hacking starts **Sat Oct 17, 10:30 AM**. Submissions are due **Sun Oct 18, 10 AM**. We are three people, each working with a coding agent. This is the final plan.

## Who owns what

| Owner | Owns |
|---|---|
| **Karan (lead)** | Scaffold, `src/types.ts`, MCP server (six tools, `mistakes` resource), MCP App, Stripe, undo orchestrator and redo, demo agent client, scripted agent mode, Manufact deploy, backup video, submission |
| **Sarah** | Everything Inkbox: task inboxes, capture and extraction, alerts and escalation (SMS, iMessage, phone), UNDO ALL / PICK / KEEP, A2A transport and email fallback, support emails, Supabase, log, live demo page |
| **Dhwanil** | The brain in `src/logic/` (`compare`, `trace`, `reversibility`, `plan_undo`, `rank`, `negotiate_step`), mock merchants and merchant agents, simulated clock, fixtures, naive arm, ~30 scenarios, grader, evals, scoreboard page |

## Checkpoints

| When | Gate | What must be true |
|---|---|---|
| **Sat 10 AM** | Kickoff | Karan asks the organizers: multiple tracks? pre-existing code? demo length? |
| **Sat 12:30 PM** | Contracts frozen | Seven contracts and the parameters locked. Demo scenario agreed. |
| **Sat 2 PM** | Capture works | `log_intent` returns a task address, a wrong-date booking arrives as an Action, Stripe charge seen, `review` returns the mismatch. |
| **Sat 6 PM** | First undo | One chain of four actions, one text, UNDO ALL, the flight refunded and verified in Stripe. Smoke eval run. |
| **Sat midnight** | Full chain | Hotel by negotiation, transfer by email, host corrected, all verified, redone correctly, MCP App live. First scoreboard run. |
| **Sun 2 AM** | Feature freeze | Bug fixes only. |
| **Sun 8 AM** | Rehearsal | All three run the full demo twice, with a timer. |
| **Sun 10 AM** | Submit | Karan submits. Live demos follow. |

## Fallback rules

- **No unique task addresses:** plus-addressing or the task id in the subject.
- **No A2A:** the Reversal Protocol runs over email with the same JSON and state machine.
- **No inbound text by 6 PM:** demo page buttons stand in for UNDO ALL / PICK / KEEP.
- **Email replies unreliable:** the merchant reply is posted from a demo page button, and the backup video shows the real moment.
- **No iMessage or calls:** use SMS reminders only.

## If we run behind, cut in this order

1. Phone call, then iMessage
2. Layer 2, the live-agent eval
3. LLM extraction for messy emails
4. SaaS and store merchants
5. Damage minimizer and `mistakes` resource polish

Never cut `log_intent` with the task inbox, `review`, chain tracing, the one-text alert, at least one negotiation, Stripe-verified refunds, redo, or the scoreboard.

## Working rules

- Tick your boxes in `03-plan.md` as you finish tasks.
- After the 12:30 PM freeze, nobody changes the contracts without all three agreeing.
- Short-lived branches, merge to `main` often, and `main` must always run.
- Report only real runs on the scoreboard. Save the raw event logs.
- The merchants and merchant agents are our mocks, and the clock is simulated. Say so on stage.
- Be honest about the limits: some mistakes can't be undone, reversal needs the merchant's cooperation, and Proxy only sees what reaches the task address and Stripe.
