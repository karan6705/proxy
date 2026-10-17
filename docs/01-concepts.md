# Proxy — Concepts Explained

Start here. This is the plain-English guide to the project and the words used in the other docs. (The repo folder is still called `tripwire`. The product is **Proxy**.)

## What is this project?

People hand AI agents real tasks every day: booking travel, buying things, signing up for software, emailing people. Agents make mistakes, and they can't reliably catch their own. The evidence of a mistake, like a confirmation email or a charge, usually arrives after the agent's session has ended. And almost every purchase has a refund window that keeps running while nobody is watching.

Today's undo tools roll back software a company controls, like files and databases. Nobody undoes what agents do in the real world: at airlines, hotels, stores and SaaS vendors.

**Proxy is the undo layer for AI agents.** Every agent will make mistakes in the real world. Proxy catches them, traces everything they broke, and undoes it all, agent to agent, before the window closes.

## The moment nobody else will show

An agent books a trip with the wrong date. Hours later, one text arrives: *"Your agent used the wrong date (Nov 3, not Nov 13). 4 things are affected, $1,240 at risk. Fully reversible for 3h 40m. Reply UNDO ALL, PICK, or KEEP."* The human replies UNDO ALL. A live chain on screen turns green, item by item, as Proxy reverses the flight, negotiates with the hotel's own agent, and corrects the email to the host. Each item turns green only when Stripe shows the refund. Then Proxy hands the corrected intent back to the original agent, which rebooks the right dates.

## How Proxy works, step by step

1. **Anchor the intent.** When an agent starts a task, it calls `log_intent` with, for example, "NYC trip for the Nov 13 conference, under $1,500." Proxy returns a unique email address for that task. The agent uses that address for every booking and signup.
2. **Capture what actually happened.** Every confirmation, receipt and invite lands in Proxy's Inkbox inbox at that task's address, so it is automatically linked to the right request. Proxy reads the structured data built into most confirmation emails first, and uses an LLM only for messy ones. Stripe events show what was actually charged.
3. **Give the agent evidence before it leaves.** At the end of the task, the agent calls `review(task_id)`. Proxy compares the receipts and charges with the intent and returns the exact mismatches, so the agent can fix what it can right away.
4. **Keep watching after the agent is gone.** Late confirmations, price changes and deliveries keep arriving. Proxy checks each one against the intent and groups related mistakes into a single **chain**: a wrong date leads to the wrong hotel nights, the wrong arrival email, and so on.
5. **Tell the human in five seconds.** One text per chain, with what went wrong, how many things it touched, the money at risk and the time left. If there is no reply, Proxy sends an iMessage, then makes a phone call before the deadline. If the human opted in, Proxy can undo automatically when the window is about to close.
6. **Undo the chain, cheapest and most urgent first.** For each action, Proxy uses the reversibility rules: the 24-hour flight rule, the hotel's free-cancellation deadline, the subscription refund window. When a full undo isn't possible, the **damage minimizer** finds the cheapest fix, like paying a $75 change fee instead of losing $412.
7. **Negotiate agent to agent.** Where a merchant has its own agent, Proxy speaks the Reversal Protocol with it.
8. **Trust the money, not the message.** A refund only counts as done when Stripe shows it.
9. **Redo it correctly.** Proxy hands the corrected intent back to the original agent, which books the right thing. Final text: "Fixed. $1,240 refunded, correct bookings made, and the host has been updated."
10. **Learn.** The mistake goes into a `mistakes` resource that agents can read, so they don't repeat it.

## The three kinds of agents

| Agent | Role | How it talks |
|---|---|---|
| **Buying agent** (any agent: Claude, ChatGPT, Codex, your own) | Does the task | Calls Proxy over MCP: `log_intent`, `reversibility`, `review`, `undo` |
| **Proxy** | Recovery agent with its own identity | MCP for agents, Inkbox for everyone else |
| **Merchant support agent** (airline, hotel, SaaS) | Decides on refunds | Inkbox A2A, with email as the fallback |

## The Reversal Protocol

The language Proxy and a merchant agent speak, over Inkbox A2A:

1. Proxy sends `request_reversal`: the order, the intent, what went wrong, the deadline and the evidence.
2. The merchant agent checks its own policy and replies `accept`, `counter` (a partial refund, store credit or an exchange), or `deny` with a reason.
3. Proxy checks the human's saved preferences, like "no store credit, partial refunds over 80% are fine." It accepts, pushes back once, or asks the human.
4. The merchant refunds through Stripe, and Proxy confirms the money in Stripe.

It is a state machine, not a chat. It has fixed steps, at most 3 rounds and a hard deadline. That prevents an "echoing" loop where two agents negotiating a return just keep agreeing with each other. Merchant messages are untrusted data, so a merchant agent can't trick Proxy into sharing anything.

If a merchant has no agent, Proxy emails support from its own address, follows up on a schedule, calls if needed, and files a Stripe dispute with the full evidence as a last resort.

## Words you will see

| Term | Meaning |
|---|---|
| **Intent** | What the human asked the agent to do: the goal, the constraints (dates, budget), and the preferences for fixing mistakes. Logged with `log_intent`. |
| **Task address** | A unique email address Proxy returns for each task. Everything the agent books or signs up for uses it, so receipts link to the right intent. |
| **Action** | One real-world thing the agent did, extracted from a receipt, confirmation or Stripe event: merchant, what, amount, dates, reference. |
| **Mismatch** | A difference between an action and the intent, such as a wrong date or an amount over budget. |
| **Chain** | A root mistake plus everything that depends on it. One text per chain. |
| **Reversibility** | How an action can be undone: the window, whether it is refundable, what reversing costs. Agents can ask before acting with `reversibility`. |
| **Damage minimizer** | When a full undo isn't possible, it picks the cheapest fix, such as a change fee instead of losing the whole price. |
| **Reversal Protocol** | The fixed-step message exchange between Proxy and a merchant agent. |
| **A2A** | Agent to agent. Inkbox lets agents with identities message each other directly. |
| **Preferences** | The human's saved rules for fixes, such as "no store credit" and "partial refunds over 80% are fine." |
| **Redo** | After the undo, Proxy hands the corrected intent back to the original agent to do it right. |
| **`mistakes` resource** | An MCP resource listing past mistakes and lessons, which agents can read so they don't repeat them. |
| **MCP / MCP server / tool / resource** | MCP is a standard way to give an AI tools. Our server offers six tools and a resource. |
| **mcp-use / Manufact Cloud** | The library we build the server with, and where we deploy it. Manufact is a hackathon track. |
| **MCP App** | A small interactive page rendered inside the agent's client. Ours is the live undo chain. |
| **Inkbox** | Gives Proxy its own identity: email, SMS and iMessage, phone and A2A. Inkbox is a hackathon track. |
| **Stripe (test mode)** | Charges, subscriptions, refunds and dispute evidence with fake money. Stripe is the source of truth for money. |
| **Supabase** | Our database and the live feed for the demo page. |
| **Simulated clock** | Refund windows are hours and days long. The demo and evals run on a clock we control, with seeded booking times, and we say so. |
| **Arm** | One version we test. The **naive arm** is an agent that checks its own work with no outside evidence and no Proxy. The **Proxy arm** is everything. |
| **Scripted agent mode** | A demo mode where the buying agent follows scripted tool calls, so the mistake fires reliably on stage. |

## Reversibility rules (demo values)

These are the rules our mock merchants use. They are based on common real-world rules, but we verify any real-world claim before putting it in the pitch.

| What the agent did | Window | How Proxy reverses it |
|---|---|---|
| Booked the wrong flight | 24 hours under the US rule if booked at least 7 days out | Cancels for a full refund |
| Booked the wrong hotel nights | The hotel's free-cancellation deadline | Cancels, or negotiates with the hotel agent after the deadline |
| Booked a ride or transfer | Usually free to cancel until shortly before | Emails support, confirms the cancel |
| Signed up for an annual SaaS plan instead of monthly | Until the vendor's refund window or renewal | Cancels and requests a refund through Stripe |
| Ordered the wrong physical item | The store's return window | Starts the return, gets the label, tracks the refund |
| Emailed a person the wrong thing | Immediately | Sends a correction |

The demo uses mock merchants for all of these. Our hotel has its own merchant agent; the airline cancels self-serve under the 24-hour rule, and the others are reached by support email, so we show every path.

## How the human stays in control

- **Only the human decides.** UNDO ALL, PICK, KEEP, and the preferences all come from the human's phone through Inkbox. No tool lets the buying agent approve an undo for a chain.
- **The agent can fix its own task.** After `review`, the agent can call `undo` for an action that `review` showed does not match the intent. Anything else goes through the human.
- **Auto-undo is opt-in.** Only if the human turned it on in the intent.
- **Merchant messages are untrusted.** Proxy never follows instructions inside them and never shares more than the evidence packet.
- **The log is append-only.** The record used in any dispute is trustworthy.

## What Proxy does not stop

We say this ourselves, before a judge asks.

- Some mistakes can't be undone, such as non-refundable purchases after the window closes. Then Proxy minimizes the damage and tells the human fast.
- Reversal needs the merchant's cooperation. In the demo the merchants and merchant agents are our own mocks, and we say so. Real merchants may refuse.
- Proxy can only catch mistakes it can see: receipts that reach the task address and charges Stripe reports. If an agent uses a different address, Proxy won't see it.
- Detecting a mismatch needs a clear intent. A vague intent gives vague results.
- The comparison is rules plus extraction, and extraction from messy emails can be wrong. That is why money is checked in Stripe, not in the message.

## Why not guardrails, payment protocols or existing undo tools?

- **Guardrails** try to stop agents before they act. Proxy assumes mistakes will happen and recovers after, including after the agent's session has ended.
- **Payment protocols** prove what was authorized. Proxy proves the outcome was wrong, and fixes it.
- **Undo tools** roll back files and databases a company owns. Proxy undoes actions in the outside world.
- **Agents grading their own work** is unreliable. Proxy checks against real evidence: receipts and Stripe charges.
- **Handling each mistake alone** misses the damage. Proxy traces the whole chain from one root mistake.
- **Undo means reverse.** Proxy undoes, then redoes it correctly.

## Claims to verify before the pitch

None of these goes on a slide or into the pitch until someone checks the source.

- Research on agents struggling to fix their own reasoning without outside feedback, and on agents overstating their success by a multiple (the 4.8 to 9.3 times figure).
- The Salesforce observation about two agents "echoing" while negotiating a return, and that agent negotiation is still years away.
- The names and capabilities of other undo tools and payment protocols we compare against.
- The US 24-hour flight rule and its seven-day condition, and any hotel or SaaS refund practice we cite.
- What Inkbox actually offers: unique per-task addresses, A2A, iMessage, outbound phone calls, and inbound text.
- "Tested in Claude Code, Codex and Cursor" is a plan. We say it only after we have done it.

## The scoreboard (how we prove it)

- About **30 scripted scenarios** (mix in `04-architecture.md`): wrong-date chains, wrong amounts, annual instead of monthly, wrong items, duplicates, late price changes, late confirmations after the agent is gone, negotiation outcomes, merchants with no agent, correct tasks that should raise no alarm, and a merchant message that tries to inject instructions.
- Run on both arms in **two layers**:
  - **Layer 1, scripted eval (headline):** replay the exact tool calls, emails and Stripe events on the simulated clock. Deterministic.
  - **Layer 2, live-agent eval:** run a real agent on the same tasks and report whatever happens, including when it makes no mistake.
- The **grader** compares what happened with what should have happened.
- Metrics (real runs only):
  - **Mistakes caught:** by the agent's own review (naive arm) vs by Proxy, and false alarms on correct tasks.
  - **Chain completeness:** how many of the things a mistake broke were found.
  - **Money recovered:** dollars reversed out of dollars at risk, and how many chains were fixed before the window closed.
  - **Redo correct:** how often the corrected booking matched the intent.
  - **False "done" claims:** refunds claimed in a message but not shown in Stripe.
  - **Time to alert**, and **tokens per task**.
- The naive arm has no capture, no chain tracing and no undo, so money recovered is a capability check, not a fair contest. We say so.
- In test runs, human replies and merchant replies are stubbed so runs never wait on a phone or inbox.

## Key files

- `02-team-plan.md`: the one-page plan.
- `03-plan.md`: who does what, and when.
- `04-architecture.md`: how it is built.
- `05-demo-flow.md`: what we do on stage.
- `06-build-steps.md`: the ordered build checklist.
