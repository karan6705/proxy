# Tripwire — Architecture

How the system is built. For the plain-English version, read `01-concepts.md`. For who builds what, read `03-plan.md`.

## What it does

An MCP server that lets any AI agent buy what it needs (API credits, a domain, a SaaS seat) through Stripe, within a budget a human sets.

- **Under budget:** the purchase goes through right away.
- **Over budget:** the human gets an email with a signed approve link (via Primitive). The agent waits, then the purchase completes.
- **Attacks:** a rules engine blocks hidden-text injection, split purchases and off-scope buys.

## Stack

Python everywhere, so the whole team can explain every part.

| Part | Choice |
|---|---|
| MCP server | `mcp-use` (Python), deployed on Manufact Cloud |
| Rules, eval harness, grader | Plain Python. `decide()` is a pure function tested with `pytest` |
| Contracts | Pydantic models for the tool schemas, the decision object and the `events` row |
| Database | Supabase (Postgres, with realtime updates) |
| Payments | Stripe test mode |
| Email | Primitive |
| Demo page | FastAPI serving one HTML page (events feed, approval status, scoreboard) plus the approve/reject page |
| Packages | `uv` |

**Fallback:** if Python won't deploy on Manufact Cloud (Karan tests this tonight), the server alone moves to TypeScript. Everything else stays in Python and talks to it through the same JSON contracts.

## System overview

```
Agent ──MCP──> Tripwire MCP server (mcp-use, Manufact Cloud)
                 │
                 ├─ Rules engine, decide() (deterministic) ──> decision
                 ├─ Purchase state machine ──> Stripe (test mode, idempotent)
                 ├─ Approval service ──> Primitive email (signed one-time link)
                 └─ Ledger (Supabase) ──> events ──realtime──> Demo page / Scoreboard

Eval harness ──Layer 1: replay scripted calls | Layer 2: run real agent──> naive arm | Tripwire arm ──> grader ──> scoreboard
```

## MCP tools (what the agent sees)

| Tool | Returns |
|---|---|
| `search_catalog(query)` | Items with `id`, `price`, `category`. Descriptions are **untrusted text** (the injection attacks are planted here). |
| `get_budget()` | Remaining budget, per-purchase limit, allowed categories |
| `request_purchase(item_id, qty, task_id, reason)` | `{decision: allowed \| escalated \| denied, purchase_id, reason_codes}` |
| `get_purchase_status(purchase_id)` | Current state. The agent polls this while it waits for approval. |

## Agent experience (AX)

The agent is our main user. This is what the Manufact and Armature judges look at.

- **Tool descriptions are written for agents.** Each says what the tool does, when to call it, and what to do next.
- **Compact JSON.** No extra text for the agent to read.
- **Reason codes tell the agent what happened and what to do:** `SPLIT_SUSPECTED`, `OUT_OF_SCOPE`, `OVER_LIMIT`, `OVER_QUANTITY`. We decide before the freeze whether to add a short `hint` field to the decision object.
- **Tokens per task is a headline metric** on the scoreboard.

## Rules engine (deterministic, no AI judge)

The rules live in one pure function: `decide(request, budget, history) -> decision`. Nimran implements it. Karan's server calls it.

Checked in this order:

1. **Scope.** The human declares allowed categories and a max quantity per item. Off-category or over-quantity gets `denied`. This catches the "buy 10 seats" injection.
2. **Budget.** Over the per-purchase limit or the remaining budget gets `escalated`.
3. **Splits.** The same item or category bought repeatedly within `WINDOW_MINUTES` (TBD), with a cumulative total over `SPLIT_THRESHOLD` (TBD), gets `escalated` with `SPLIT_SUSPECTED`. Both values are set at the Sat 12:30 PM freeze (or by 2 PM, if the team agrees).

**Naive arm** = the same server with only the budget check. It is the baseline for the scoreboard. The other arm is the **Tripwire arm** (all three rules).

## What the rules do not stop

Be honest about this in the pitch and in Q&A.

- An injected purchase that is in an allowed category, under the quantity limit and under budget will go through. Tripwire limits the damage (the blast radius). It does not make injection impossible.
- A static Stripe spending limit also can't scope purchases per task or escalate to a human. That is the gap we fill.

## Purchase state machine

```
requested → allowed → executing → completed | failed
requested → escalated → approved → executing → completed
                     └→ rejected | expired
requested → denied
```

- `purchase_id` is the Stripe idempotency key, so a double-tap can't charge twice.
- The approval token is an HMAC of the purchase id and an expiry. It works once and is stored hashed.

## Ledger (Supabase)

| Table | Columns |
|---|---|
| `budgets` | limit, per_purchase_cap, allowed_categories, max_qty |
| `purchases` | item, qty, amount, state, reason_codes, stripe_id |
| `approvals` | token_hash, expiry, used_at |
| `events` | Append-only log of every tool call. Columns: `run_id`, `arm` (naive \| tripwire), `scenario_id`, `layer` (policy \| live), `tool_name`, `decision`, `reason_codes`, `tokens_in`, `tokens_out`, `timestamp`. Feeds the scoreboard and the live page through Supabase realtime. |

Demo runs aren't scenarios. For those, we agree at the freeze what `scenario_id` and `run_id` hold (for example, null or a fixed value).

## Eval harness

Two layers, both run against the naive arm and the Tripwire arm on about 30 scenarios.

- **Layer 1, policy eval (the scoreboard headline).** Replay scripted tool-call sequences (the exact malicious requests a compromised agent would send) against both arms. Deterministic.
- **Layer 2, live-agent eval.** Run the real agent on the same scenarios and report whatever happens, including cases where the agent resists an attack on its own.
- Eval mode stubs approvals (the expected outcome is just `escalated`), so runs never wait on email.
- The grader compares each actual decision to the scenario's expected decision.
- Scoreboard: unauthorized-spend rate, over-escalation rate, splits caught, tokens per task. **Real runs only.**
- **Compromised-agent demo mode:** for the live demo, the agent runs with scripted tool calls or a deliberately weak system prompt so the attacks fire reliably.

## Frozen contracts (by Sat 12:30 PM)

1. Tool schemas
2. Decision object (`decision`, `purchase_id`, `reason_codes`, and possibly `hint`)
3. `events` row format (`run_id`, `arm`, `scenario_id`, `layer`, `tool_name`, `decision`, `reason_codes`, `tokens_in`, `tokens_out`, `timestamp`)
4. Policy function: `decide(request, budget, history) -> decision` (a pure function; Nimran implements it, Karan's server calls it)

Also agreed at the freeze: `WINDOW_MINUTES = TBD` and `SPLIT_THRESHOLD = TBD`.

Everything else may change without blocking anyone.

## Stretch: two-way email

If we're ahead, the human can reply to the approval email ("approve" or "reject, too expensive") and the agent acts on the reply. This fits the Primitive track better than a one-way link. It is the first thing we cut if we run behind.

## Tracks

- **Stripe:** safe agent spending (main pitch).
- **Manufact:** best MCP server for agents.
- **Armature:** agent experience.
- **Primitive:** email approval (bonus, stronger with two-way replies).
