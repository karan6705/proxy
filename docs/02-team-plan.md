# Tripwire — Team Plan (one page)

Details live in `03-plan.md`. This is the short version.

## What we're building

An MCP server that lets an AI agent buy things with Stripe inside a budget a human sets. Under budget, it buys right away. Over budget, a human gets an email and approves. A rules engine blocks the tricks that make agents overspend, and a scoreboard from real runs proves it.

Hacking starts **Sat Oct 17, 10:30 AM**. Submissions are due **Sun Oct 18, 10 AM**.

## Who owns what

| Owner | Owns |
|---|---|
| **Karan (lead)** | MCP server, `request_purchase`, purchase state machine, Stripe test mode, demo agent client, Manufact Cloud deploy, backup video, submission |
| **Sarah** | Supabase tables and event logging, live events page, Primitive approval email, signed one-time links, approve/reject, approval-loop hardening |
| **Nimran** | Mock catalog, `decide()` rules (with split detection), attack scenarios, compromised-agent mode, scoreboard page |
| **Dhwanil** | Normal and over-budget scenarios, grader, eval runs (both layers), scoreboard numbers |

## Checkpoints

| When | Gate | What must be true |
|---|---|---|
| **Sat 10 AM** | Kickoff | Karan asks the organizers: multiple tracks? pre-existing code? demo length? |
| **Sat 12:30 PM** | Contracts frozen | Tool schemas, decision object, `events` row and `decide()` are locked. |
| **Sat 2 PM** | Purchase works | One Stripe test-mode purchase works start to finish. |
| **Sat 6 PM** | Email works | Email approval works, all scenarios are written, and a smoke eval (about 10 scenarios, both arms, both layers) has run. |
| **Sat midnight** | First scoreboard | First full scoreboard run is done. |
| **Sun 2 AM** | Feature freeze | No new features. Bug fixes only. |
| **Sun 8 AM** | Rehearsal | All four run the full demo (see `05-demo-flow.md`) twice, with a timer. |
| **Sun 10 AM** | Submit | Karan submits. Live demos follow. |

## Fallback rules

- **No working email by 6 PM:** approval moves into the UI. The approve and reject buttons go on the demo page, and email is dropped from the live demo. The backup video shows the email step. Stop debugging email at 6 PM.
- **No working Stripe by 2 PM:** use a mock charge (mark the purchase completed without calling Stripe) so everyone keeps moving. Keep trying until 6 PM. If it still fails, say so in the demo.
- **Python won't deploy on Manufact Cloud:** Karan tests this tonight. If it fails, the server alone moves to TypeScript.

## If we run behind, cut in this order

1. Two-way email replies (stretch goal)
2. Layer 2, the live-agent eval
3. Polish on split detection

Never cut the attack catch, the Stripe purchase, or the scoreboard.

## Working rules

- Tick your boxes in `03-plan.md` as you finish tasks.
- After the 12:30 PM freeze, nobody changes the contracts without all four agreeing.
- `main` must always run. Merge small and often.
- Report only real runs on the scoreboard. Save the raw event logs.
- Be honest about the limits: Tripwire limits the damage a hijacked agent can do. It doesn't make injection impossible.
