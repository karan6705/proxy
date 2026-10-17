# Tripwire — Plan

**What we're building:** an MCP server that lets an AI agent buy things (API credits, a domain, a SaaS seat) with Stripe, inside a budget a human sets. Under budget, it buys right away. Over budget, it emails a human an approve link. It also blocks the tricks that make agents overspend, and we prove that with a scoreboard from real runs.

**Read first:** `01-concepts.md` (what the words mean), then this file. `02-team-plan.md` is the one-page version. `04-architecture.md` is how it's built. `05-demo-flow.md` is what we do on stage.

**Time:** hacking starts Sat Oct 17, 10:30 AM. Submissions are due Sun Oct 18, 10 AM. That is about 23.5 hours.

## How to use this file

- Find your name. Those are your jobs.
- Tick the box (`[x]`) when a job is done.
- Checkpoints are go/no-go gates. If a gate fails, use its fallback and move on.
- Claude skills (the `/ecc:...` names) are optional helpers. They are listed at the bottom.

## Who owns what

| Person | Owns |
|---|---|
| **Karan (lead)** | The MCP server, `request_purchase`, the purchase state machine, Stripe test mode, the demo agent client, the Manufact Cloud deploy |
| **Sarah** | Supabase tables and event logging, the live events page, the Primitive approval email, signed one-time links, approve/reject |
| **Nimran** | The mock catalog, the `decide()` rules (including split detection), the attack scenarios, compromised-agent mode, the scoreboard page |
| **Dhwanil** | Normal and over-budget scenarios, the grader, the eval runs (both layers), the scoreboard numbers |

Karan, Sarah and Nimran carry about the same load. Dhwanil's load is lighter (easy to moderate).

## What we're going for

- **Main pitch: safe agent spending (Stripe).** The server also fits Manufact (best MCP server for agents) and Armature (agent experience), so those come along with the same work.
- **Bonus: Primitive.** Their track is about agents that send and receive messages. Our email approval is a one-way link. It only fits well if the human can also reply to the email. That is a stretch goal (see "If we run behind").

## Phases

### Phase 0: Tonight

- [ ] **Karan:** read the mcp-use quickstart and the Stripe test-mode docs.
- [ ] **Karan:** deploy a tiny Python "hello world" mcp-use server to Manufact Cloud and confirm it answers. If Python won't deploy, we build the server in TypeScript and keep everything else in Python.
- [ ] **Sarah:** read the Primitive docs, make an account, and send yourself a test email.
- [ ] **Nimran:** write a list of the attacks we want to catch: hidden text in a product page, splitting one buy into small buys, buying something unrelated.
- [ ] **Dhwanil:** decide how a test scenario is written down (as a scripted tool-call sequence) and what the right answer looks like for each one.
- [ ] **Everyone:** make sure your Claude/API key works.
- [ ] **At kickoff, Sat 10 AM, Karan:** ask the organizers: can one project enter multiple tracks? Is pre-existing code allowed? How long is the demo slot?

### Phase 1: Set up (Sat, 10:30 AM to 12:30 PM)

- [ ] **All four:** agree on and lock four things. After 12:30 PM nobody changes them without everyone agreeing.
  1. The tool inputs and outputs.
  2. The decision format (we decide whether to add a short `hint` field that tells the agent what to do next).
  3. The event log format (fields are in `04-architecture.md`).
  4. The rules function `decide(request, budget, history) -> decision`.

  Also set the split rule values `WINDOW_MINUTES` and `SPLIT_THRESHOLD`, or agree who sets them by 2 PM.
- [ ] **Karan:** set up the project so the server runs on your laptop with fake tools.
- [ ] **Karan:** choose and set up the demo agent client: Claude connected to the remote MCP URL, or our own tool loop.
- [ ] **Sarah:** create the Supabase database and its tables.
- [ ] **Nimran:** build the mock product catalog.
- [ ] **Dhwanil:** build a script that can run a scenario against the server on either arm, in both layers (scripted replay and live agent).

### Phase 2: Make a purchase work (Sat, 12:30 PM to 2 PM)

- [ ] **Karan:** make `request_purchase` work (it calls Nimran's `decide()`) and charge Stripe test mode.
- [ ] **Karan:** write the tool descriptions for agents. Each one says what the tool does, when to call it, and what to do next.
- [ ] **Nimran:** implement `decide(request, budget, history)`: is this item allowed, and is it within budget? Write the tests first.
- [ ] **Sarah:** log every tool call to the database and show it on a simple live events page.
- [ ] **Dhwanil:** write the first 10 scenarios (normal buys and over-budget buys).
- [ ] **Checkpoint 2 PM:** one purchase works start to finish with Stripe.
  - **Fallback:** if Stripe isn't working, mark the purchase as completed without calling Stripe (a "mock charge") so everyone else keeps moving. Keep trying Stripe test mode until 6 PM. If it still fails, the demo uses the mock charge and we say so out loud.

### Phase 3: Email approval and attacks (Sat, 2 PM to 6 PM)

Dinner is at 5 PM. Plan around it.

- [ ] **Sarah:** send the approval email with a one-time link. The approve and reject buttons must work.
- [ ] **Karan:** let the agent check "is my purchase approved yet?" and handle links that expire.
- [ ] **Nimran:** add split-purchase detection inside `decide()`. Add the hidden-text attacks to the catalog.
- [ ] **Nimran:** write the ~10 attack scenarios (hidden text, split, off-scope) as scripted tool-call sequences with their expected decisions.
- [ ] **Nimran:** test whether the real agent takes the bait on attacks 1 (hidden text) and 2 (split purchase). Write down what happens either way.
- [ ] **Dhwanil:** write the next ~10 scenarios (normal, over-budget and off-scope buys, each with its expected decision) and the grader that checks right vs wrong, for both layers.
- [ ] **Checkpoint 6 PM:** email approval works, all scenarios are written, and a smoke eval has run (about 10 scenarios, both arms, both layers).
  - **Fallback:** if email approval isn't working, approval moves into the UI. The approve and reject buttons go on the demo page, and we drop email from the live demo. Stop debugging email at 6 PM.

### Phase 4: Scoreboard and demo (Sat, 6 PM to midnight)

- [ ] **Dhwanil:** Layer 1 (policy eval): replay all scenarios on the naive arm and the Tripwire arm. This is the headline of the scoreboard.
- [ ] **Dhwanil:** Layer 2 (live-agent eval): run the real agent on the same scenarios and report whatever happens, including cases where the agent resists an attack on its own. Save the results as a file the scoreboard page can read.
- [ ] **Dhwanil:** make tokens per task a headline number on the scoreboard, not a footnote.
- [ ] **Sarah:** harden the approval loop: link used twice, expired link, wrong token, double-tap. Run the email flow on a real phone and note how long the email takes to arrive. Show approval status on the live events page.
- [ ] **Nimran:** build the scoreboard page that shows Dhwanil's results file.
- [ ] **Nimran:** build compromised-agent mode (scripted tool calls or a deliberately weak system prompt) for demo steps 2 and 4.
- [ ] **Nimran:** fix any rules that the scenario runs show are wrong.
- [ ] **Karan:** put the server on Manufact Cloud and test it there.
- [ ] **Checkpoint midnight:** first full scoreboard run is done.

### Phase 5: Finish (Sunday)

- [ ] **2 AM, feature freeze:** stop adding features. Only fix bugs.
- [ ] **Dhwanil:** do the final scoreboard run (both layers) and save the raw event logs.
- [ ] **Karan:** fix bugs and record a backup video of the email moment.
- [ ] **Sarah:** fix bugs.
- [ ] **Nimran:** fix bugs.
- [ ] **8 AM, rehearsal:** all four practice the full demo twice, with a timer. See `05-demo-flow.md`.
- [ ] **Karan:** submit the project before the Sun 10 AM deadline. Live demos start right after.

## If we run behind

Drop things in this order. Never drop the attack catch, the Stripe purchase, or the scoreboard.

1. Two-way email replies (the Primitive stretch goal).
2. Layer 2, the live-agent eval.
3. Polish on split detection.

**Stretch goal, only if we're ahead:** **Sarah** lets the human reply to the approval email ("approve" or "reject, too expensive") and the agent acts on the reply.

## Risks

| Risk | Likelihood | What we do |
|---|---|---|
| Four integrations in 23.5 hours | High | Checkpoints with fallbacks (mock charge, approval in the UI) |
| Python won't deploy on Manufact Cloud | Low to medium | Test tonight. Fall back to TypeScript for the server only |
| Email is unreliable on stage | Medium | Backup video; approval buttons in the UI |
| Called "just rules" | Medium | Show the scored eval against the naive arm. Rules are stable and easy to explain |
| Scoreboard looks faked | Medium | Report only real runs and keep the raw event logs |
| The real agent resists the attacks, so the naive arm shows no unauthorized spend | Medium | Layer 1 scripted eval (the exact malicious requests replayed on both arms) and compromised-agent demo mode |
| Overclaiming security | Medium | Say we limit the damage, we don't make injection impossible. See "What Tripwire does not stop" in `01-concepts.md` |
| Contract drift between four people | Medium | Freeze four contracts Sat 12:30 PM |
| Pre-existing code or multi-track rules | Low | Ask organizers at kickoff (Sat 10 AM) |

## Success criteria

- The live attack catch works on stage.
- The scoreboard is from real runs, with raw event logs saved.
- The email approve loop completes one real Stripe test purchase (or the demo clearly says it used the UI approval or a mock charge).
- Everyone can explain what Tripwire does and what it does not stop.

## Optional Claude skills

Type the name in Claude Code to use one. None are required.

| Person | Skills |
|---|---|
| Everyone | `/ecc:contract-first`, `/ecc:api-design` (for the Phase 1 contracts) |
| Karan | `/ecc:mcp-server-patterns`, `/ecc:error-handling`, `/ecc:deployment-patterns` |
| Sarah | `/ecc:security-review`, `/ecc:e2e-testing` |
| Nimran | `/ecc:tdd-workflow`, `/ecc:frontend-design-direction` |
| Dhwanil | `/ecc:eval-harness`, `/ecc:agent-eval`, `/ecc:benchmark-methodology` |
