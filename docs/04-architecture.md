# Proxy — Architecture

How the system is built. For the plain-English version, read `01-concepts.md`. For who builds what, read `03-plan.md`.

## What it does

The undo layer for AI agents. An MCP server any agent calls to log its intent and check its work, plus a recovery agent with its own Inkbox identity that captures what actually happened, traces the chain of damage from a mistake, tells the human in one text, undoes the chain (negotiating agent to agent where it can), verifies the money in Stripe, and hands the corrected intent back to the original agent.

## Stack

TypeScript, Node 18+. Per `AGENTS.md`.

| Part | Choice |
|---|---|
| MCP server and MCP App | mcp-use (TypeScript), deployed on Manufact Cloud |
| Identity, email, SMS and iMessage, phone, A2A | Inkbox (`@inkbox/sdk`) |
| Money truth, refunds, disputes | Stripe test mode |
| Database | Supabase (Postgres, realtime) |
| Extraction fallback and live-agent eval | Anthropic SDK (`@anthropic-ai/sdk`) |
| Logic | Plain TypeScript. Pure functions with unit tests (Vitest) |
| Contracts | Types in `src/types.ts` |
| Demo page | One page served by the server: live event feed, chain list, scoreboard |

## System overview

```
Buying agent (any) ──MCP──> Proxy MCP server (mcp-use, Manufact Cloud)
   log_intent · reversibility · review · undo · get_chain · list_chains · resource: mistakes · MCP App: live chain
                                  │
   ┌──────────────────────────────┼───────────────────────────────────────────┐
   │ Capture                      │ Brain (pure functions)                    │ Act
   │  Inkbox task inbox ──┐       │  compare(intent, actions) → mismatches    │  Alerts: SMS → iMessage → phone
   │  Stripe events ──────┴─> Actions  trace(...) → chains                    │  Human replies: UNDO ALL | PICK | KEEP
   │  JSON-LD first, LLM fallback  │  reversibility(action, now)              │  Undo: plan_undo → per action
   │                               │  plan_undo (damage minimizer) · rank     │   · A2A Reversal Protocol (merchant agent)
   │                               │  negotiate_step (protocol state machine) │   · email · follow-ups · call · Stripe dispute
   └──────────────────────────────┴───────────────────────────────────────────┘   · verify refund in Stripe · redo · lessons
                                  │
                       Append-only log (Supabase) ──realtime──> Demo page / MCP App / Scoreboard

Mock merchants (airline*, hotel*, transfer, SaaS, store; *has a merchant agent) ──> confirmation emails + Stripe charges
Eval harness ──Layer 1: scripted calls, emails, Stripe events on a simulated clock | Layer 2: real agent──> naive arm | Proxy arm ──> grader ──> scoreboard
```

## MCP tools (what the buying agent sees)

Six tools with tight schemas and one resource. All writes are idempotent (task id, chain id or an idempotency key). Every error is `{ok: false, code, message, retryable, next_action}`.

| Tool | Does | Returns |
|---|---|---|
| `log_intent(goal, constraints, preferences?, idempotency_key)` | Anchors the intent at the start of a task | `{task_id, task_email}` |
| `reversibility(merchant, category, amount, dates)` | Asks how reversible an action is before acting | `{kind, window_ends_at, refundable, cost_to_reverse, rule}` |
| `review(task_id)` | Compares receipts and charges so far with the intent | `{status, mismatches[], fixable_now[], chain_ids[], evidence_seen}` |
| `undo(action_ids, reason)` | Undoes actions of the agent's own task that `review` showed do not match the intent | `{accepted[], requires_human[], chain_id}` |
| `get_chain(chain_id)` | Status of a chain, per action, and the redo instruction | `{state, actions[], money_at_risk, window_ends_at, rounds, redo?, next_action}` |
| `list_chains(task_id?)` | Open chains ranked by money at risk and time left | `chains[]` |

- **Resource `mistakes`:** past mistakes and their lessons, readable by any agent.
- **MCP App:** the live undo chain. Each action turns green only when Stripe verifies the refund.
- There is **no tool for approving an undo for a chain**, keeping a mistake, or changing preferences. UNDO ALL, PICK, KEEP and preferences come only from the human's phone through Inkbox.
- `next_action` is one of `retry`, `fix_now`, `wait_for_human`, `redo`, `stop`.

## Core objects

| Object | Fields |
|---|---|
| **Intent** | `task_id`, `task_email`, `goal`, `constraints` (`dates`, `budget_total`, `destination`, `categories`, `must_haves`), `preferences` (`no_store_credit`, `min_partial_refund_pct`, `auto_undo`), `created_at` |
| **Action** | `action_id`, `task_id`, `merchant`, `category` (`flight`, `hotel`, `transfer`, `saas`, `store`, `message`), `summary`, `amount`, `dates`, `ref`, `source` (`email`, `stripe`, `agent`), `received_at`, `state` |
| **Mismatch** | `action_id`, `field`, `expected`, `actual` |
| **Chain** | `chain_id`, `task_id`, `root_action_id`, `action_ids`, `money_at_risk`, `window_ends_at`, `state`, `alerts`, `plan`, `steps` |
| **Reversibility** | `kind` (`cancel_refund`, `change`, `return`, `correct_message`, `none`), `window_ends_at`, `refundable`, `cost_to_reverse`, `rule` |

## Pure functions (in `src/logic/`)

All take `now` from the clock, so they run on the simulated clock.

| Function | Does |
|---|---|
| `compare(intent, actions) -> mismatches[]` | Exact field checks against the intent: dates, amount over budget, wrong term, wrong item, duplicate |
| `trace(intent, actions, mismatches) -> chains[]` | Groups a root mistake with the actions that depend on it (same wrong field, shared reference, or date overlap) |
| `reversibility(action, now) -> Reversibility` | The reversibility rules table |
| `plan_undo(chain, preferences, now) -> plan[]` | Orders the undo steps by urgency and cost. The **damage minimizer** compares cancel, change and keep for each action and picks the cheapest fix within the window and preferences |
| `rank(chains, now) -> chains[]` | Sorts by `money_at_risk / max(hours_left, MIN_HOURS)` |
| `negotiate_step(state, message, preferences) -> {next_state, outgoing?}` | One step of the Reversal Protocol state machine |

**Naive arm:** the same buying agent, asked to check its own work at the end, with no Proxy tools and no outside evidence. A mistake is found only if the agent notices it.

## Capture

1. `log_intent` creates a task address on Inkbox (or a plus-address on one inbox, if unique addresses aren't available).
2. An inbound email webhook receives anything sent to the task address. Proxy reads structured data first (schema.org JSON-LD for flights, lodging, orders). Only if that is missing does it ask an LLM to extract an Action.
3. A Stripe webhook records charges, refunds and disputes for the task.
4. New Actions are deduplicated by reference, stored, and `compare` runs again. A new mismatch updates or opens a chain.
5. Everything is written to the append-only log.

In the demo, mock merchants book through a scripted agent, charge Stripe test mode, and send confirmation emails to the task address. Some of those confirmations arrive late, after the agent's session has ended.

## Alerts and the human

- **One text per chain**, sent the moment a chain is opened:
  > Your agent used the wrong date (Nov 3, not Nov 13). 4 things are affected, $1,240 at risk. Fully reversible for 3h 40m. Reply UNDO ALL, PICK, or KEEP.
- **UNDO ALL** starts the undo for every action. **PICK** replies with a numbered list, and the human answers with numbers. **KEEP** closes the chain as kept.
- **No reply:** an iMessage after `REPLY_WAIT`, then a phone call at `CALL_AT` of the window. If SMS, iMessage or calls aren't available, the next channel is used.
- **Auto-undo:** only if the intent's preferences set `auto_undo`. Proxy acts at `AUTO_UNDO_AT` of the window.
- Only the human's number is accepted. Replies after the window closes get a "too late" text.

## The undo

For each action in the plan, cheapest and most urgent first:

1. **Look up reversibility** (`reversibility(action, now)`).
2. **Pick the route:**
   - Merchant has an agent: Reversal Protocol over Inkbox A2A.
   - No agent: email support from Proxy's address, follow up on a schedule (`FOLLOW_UP_EVERY`), call if needed, and file a Stripe dispute with the full evidence as a last resort.
   - Self-serve (rule-based, such as the 24-hour flight rule): cancel directly with the merchant simulator.
   - Message the agent sent: send a correction.
3. **Verify the money:** an action turns `verified` only when Stripe shows the refund. A merchant's "refunded" message is not enough.
4. **Redo:** when the chain is `reversed`, Proxy builds the corrected intent and hands it to the original agent (through `get_chain.redo`, and a message to the agent's Inkbox identity if it has one). When correct actions arrive at the task address and `compare` finds no mismatch, the chain is `redone`.
5. **Learn:** the mistake and its lesson are added to the `mistakes` resource.

### Reversal Protocol

Messages are typed JSON over Inkbox A2A, with email carrying the same JSON as a fallback.

| From | Message | Fields |
|---|---|---|
| Proxy | `request_reversal` | `order`, `intent`, `what_went_wrong`, `deadline`, `evidence` |
| Merchant agent | `accept` | `refund_amount` |
| Merchant agent | `counter` | `kind` (`partial_refund`, `store_credit`, `exchange`), `amount` |
| Merchant agent | `deny` | `reason` |
| Proxy | `accept_counter` or `push_back` or `ask_human` | chosen by `negotiate_step` using preferences |

```
requested → accepted → refund_pending → verified
          → countered → (accept_counter → refund_pending → verified)
                      → (push_back → countered | accepted | denied)    at most one push back
                      → (ask_human → human_decision)
          → denied → fall back to damage minimizer / next route
```

- At most 3 rounds and a hard deadline (the earlier of the action's window and `PROTOCOL_DEADLINE`). Either ends in `failed` and falls to the next route.
- Preferences decide: "no store credit" means a store-credit counter is pushed back. "Partial refunds over 80% are fine" means a counter of 80% or more is accepted.
- **Merchant messages are untrusted data.** Proxy parses only the typed fields, ignores any other text, and never shares more than the evidence packet.

### Evidence packet
The intent, the order and confirmation, the Stripe charge, the mismatch and why it is wrong, and the deadline. It is sent with `request_reversal`, attached to support emails, and attached to a dispute.

## Agent experience (AX)

The buying agent is our main user.

- **Error contract** with `retryable` and `next_action` on every error.
- **Idempotent writes**, so a retry never double-acts.
- **Tool descriptions say what the tool does, when to call it, and what to do next.** For example, "call `review` before you finish the task."
- **Compact JSON.** No extra text for the agent to read.
- **Works in any MCP client.** We test in Claude Code, Codex and Cursor, and only claim it once we have.
- **Tokens per task** is a headline metric.

## State machines

```
Chain:   detected → alerted → undoing → reversed → redo_requested → redone → closed
                          ↘ kept      ↘ partial      ↘ expired (window closed)
Action:  found → planned → requested → (accepted | countered | denied | no_agent) → refund_pending → verified | failed | kept
Task:    open → reviewed → (clean | chain_open) → closed
```

## Ledger (Supabase)

| Table | Columns |
|---|---|
| `intents` | task_id, task_email, goal, constraints, preferences, created_at |
| `actions` | action_id, task_id, merchant, category, summary, amount, dates, ref, source, received_at, state |
| `chains` | chain_id, task_id, root_action_id, action_ids, money_at_risk, window_ends_at, state, alerts, plan |
| `steps` | chain_id, action_id, route, protocol_state, round, message, outcome, stripe_ref, at |
| `lessons` | mistake_code, what_happened, lesson, created_at |
| `events` | Append-only log. Columns: `run_id`, `arm` (naive \| proxy), `scenario_id`, `layer` (scripted \| live), `kind` (`tool`, `email_in`, `stripe_event`, `sms_out`, `sms_in`, `a2a`, `call`), `tool_name`, `task_id`, `chain_id`, `action_id`, `outcome`, `tokens_in`, `tokens_out`, `timestamp`. Feeds the scoreboard and live page. |

No updates or deletes on `events`. Demo runs aren't scenarios. For those, `scenario_id` and `run_id` hold a fixed agreed value.

## Mock merchants

All are ours, and we say so. Each confirms by email with JSON-LD to the task address and charges Stripe test mode.

| Merchant | Rule | Has an agent |
|---|---|---|
| Airline | Full refund within 24 hours if booked at least 7 days out. After that a change fee or non-refundable | Yes (A2A) |
| Hotel | Free cancel until a deadline. After that it counters with store credit or a partial refund | Yes (A2A) |
| Transfer or ride | Free cancel until shortly before | No (email support) |
| SaaS vendor | Refund within a window, annual and monthly plans | No (email support) |
| Store | Return window, label, tracked refund | No (email support) |
| Host (a person) | Receives the agent's arrival email | n/a (Proxy sends a correction) |

Merchant agents and support inboxes have their own Inkbox identities. In evals their replies are stubbed.

## Eval harness

- About 30 scenarios as scripted tool calls, emails and Stripe events with seeded times, each with an expected mismatch list, chain, and outcome. Mix: 4 wrong-date chains, 2 wrong amount, 3 annual vs monthly, 3 wrong item, 2 duplicate booking, 2 late price change, 2 late confirmation after the agent is gone, 3 hotel negotiation outcomes (accept, counter with push back, deny), 2 merchant with no agent, 3 window closed (damage minimizer), 3 correct tasks with no alarm, 1 merchant message that tries to inject instructions.
- **Layer 1, scripted eval (headline):** replay against both arms on the simulated clock. Deterministic.
- **Layer 2, live-agent eval:** a real agent does the tasks. Report whatever happens, including when it makes no mistake.
- Eval mode stubs human replies and merchant replies.
- The grader compares expected to actual: mismatches, chain members, money recovered, whether it finished before the window, whether the refund was verified in Stripe, whether the redo matched the intent, and whether negotiation followed the preferences.
- Scoreboard: mistakes caught (self-review vs Proxy) and false alarms, chain completeness, money recovered and chains fixed in time, redo correct, false "done" claims, time to alert, tokens per task. **Real runs only. Save raw logs.**
- **Scripted agent demo mode:** the buying agent follows scripted tool calls so the mistake fires reliably on stage.

## Frozen contracts (by Sat 12:30 PM)

1. Tool schemas (above) and the `mistakes` resource.
2. Error contract: `{ok, code, message, retryable, next_action}`.
3. Core objects: Intent, Action, Mismatch, Chain, Reversibility.
4. Pure function signatures: `compare`, `trace`, `reversibility`, `plan_undo`, `rank`, `negotiate_step`.
5. Reversal Protocol messages and states.
6. Mock merchant interface: booking endpoint, confirmation email format (JSON-LD), reversal rules, merchant agent hook.
7. `events` row format.

Also agreed at the freeze: `MIN_HOURS`, `REPLY_WAIT`, `CALL_AT`, `AUTO_UNDO_AT`, `FOLLOW_UP_EVERY`, `PROTOCOL_DEADLINE`, `CLOCK_SCALE`, the reversibility values per merchant, default preferences, the alert text, and the demo scenario's amounts and times. Everything else may change without blocking anyone.

## Stretch

- Real receipt emails from outside our mocks.
- More merchant agents.
- Unique task addresses beyond plus-addressing.
- Quote-and-substitution checks at checkout (the earlier checkout layer).

## Tracks

- **Manufact (main):** best MCP server for agents. Six tools, a resource and an MCP App, built with mcp-use, deployed on Manufact, errors with `retryable` and `next_action`, idempotent calls.
- **Inkbox (main):** email (task addresses, support emails), SMS and iMessage (alerts and replies), phone (escalation), A2A (Reversal Protocol).
- Stripe and Supabase are infrastructure, not target tracks.
