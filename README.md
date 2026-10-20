# Proxy: the undo layer for AI agents

Agents book, buy and email on our behalf, and sometimes they get it wrong. Proxy is an MCP server that sees every receipt and Stripe charge a task produces, catches what doesn't match what the human asked for, and undoes the whole chain: merchant agent to merchant agent, before the refund window closes. Money only counts once Stripe shows it.

Built for YC "Make Something Agents Want" (tracks: Manufact, Inkbox). Source: https://github.com/karan6705/proxy (the folder is still called `tripwire` in places).

## Try it in 60 seconds

The cloud copy is `https://bold-zero-0m4lf.run.mcp-use.com/mcp`, a simulated sandbox: no real money, messages or merchants.

1. **Add it to your client** (more in [CLIENTS.md](CLIENTS.md)).

   Claude Code:
   ```bash
   claude mcp add --transport http proxy https://bold-zero-0m4lf.run.mcp-use.com/mcp
   ```
   Cursor, in `.cursor/mcp.json`:
   ```json
   { "mcpServers": { "proxy": { "url": "https://bold-zero-0m4lf.run.mcp-use.com/mcp" } } }
   ```
2. **Call `try_proxy_demo`.** It runs the whole story in about a second: an agent books a trip for Nov 3 instead of Nov 13, Proxy alerts a (simulated) human, who replies UNDO ALL, and Proxy undoes the chain. You get a `chain_id` and a plain-English summary.
3. **Call `get_chain` with that `chain_id`** to see every action, the refunds, and "$1,144 of $1,240 recovered". Clients that support MCP Apps also render the live-chain view. `list_chains` shows every run.

To use Proxy around your own agent, call `log_intent` first (see the tools below), or ask your agent to use the `undo_my_agents_mistake` prompt.

## The tools

| Tool | What it does |
|---|---|
| `log_intent` | Records what the human asked for and returns a task email unique to this task. Call it first. |
| `reversibility` | Says how undoable an action would be before you take it: window, refundable, cost. |
| `review` | Compares the receipts and charges that reached the task email with the intent; returns exact mismatches. Call it before saying "done". |
| `undo` | Undoes the agent's own flagged actions that are free to undo, during its session. Everything else goes to the human. |
| `get_chain` | One undo chain, live: each action's state, money at risk, time left, and the redo instruction. Shows the live-chain widget (an MCP App). |
| `list_chains` | Open chains, ranked by money at risk and time left. |
| `try_proxy_demo` | Runs the whole story in a simulated sandbox and returns a chain to inspect. On the cloud copy and in demo mode. |

There is also a prompt, `undo_my_agents_mistake`, that walks an agent through all of it, and a `mistakes` resource with lessons learned.

## How the demo works

1. A buying agent books a trip for Nov 3 instead of Nov 13: flight, hotel, airport transfer, and an email to the host. It undoes the flight itself (free under the 24-hour rule), says it's done, and leaves.
2. The late confirmations arrive. Proxy groups everything the wrong date broke into one chain and sends the human one iMessage: "$828 at risk of $1,240. Reversible for 3h 40m. Reply UNDO ALL, PICK or KEEP."
3. The human replies UNDO ALL. Proxy negotiates with the hotel's agent over Inkbox A2A: store credit is refused per the human's preferences, then 85% ($544) is accepted. It emails the transfer desk for a full refund ($188) and sends the host a correction. Each refund turns green only when Stripe (test mode) confirms it.
4. "All done. $1,144 of $1,240 back." The agent gets the corrected intent and rebooks for Nov 13; Proxy checks the new confirmations.

Run it: `npm run demo:stage` (checks env, starts the hotel agent, resets), then `npm run demo:go`. Without network: `npm run demo:offline-stage`. The stage page is at `/web/stage`, the scoreboard at `/scoreboard`.

The merchants and merchant agents are our own mocks, payments are Stripe test mode, and the demo clock is simulated.

## Eval results

From our latest runs (`evals/results/`), with the caveats below:

| | Agent checking its own work | With Proxy |
|---|---|---|
| **Scripted, 34 scenarios:** mistakes caught | 1 of 44 | 39 of 44 (5 are documented known misses) |
| Chain members found | 0 of 40 | 40 of 40 |
| False "done" claims | 27 | 0 |
| **Live agent** (Claude Haiku 4.5, 25 episodes per arm): mistakes caught | noticed in 3 of 8 episodes with mistakes | 6 of 6 mistakes, 0 false alarms |
| False "done" claims | 5 | not reported for this arm |
| Tokens | 69,245 | 99,747 |

Caveats: in the scripted layer the self-checking arm is a scripted self-review, so its numbers are not a measured miss rate, and refunds there are merchant-agreed, not Stripe-verified. The live layer is small (5 tasks × 5 trials), and the two arms made different mistakes, so compare rates, not totals.

## Repo

`src/tools` (MCP tools), `src/orchestrator` (chains, undo routes, Reversal Protocol), `src/app` (the widget), `src/inkbox` and `src/capture` (identity, email, texts, A2A), `src/logic` and `src/merchants` (rules and mock merchants), `src/stripe`, `evals/`. Design docs start at `docs/01-concepts.md`.

# Team

- Karan Raval ([@karan6705](https://github.com/karan6705))
- Dhwanil ([@dhwanil1907](https://github.com/dhwanil1907))
- Sarah Khadder ([@YOUR_USERNAME](https://github.com/skhadder))