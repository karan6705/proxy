# Proxy: rules for every agent in this repo

## What we are building
Proxy (repo folder: tripwire) is the undo layer for AI agents. Any agent calls it over MCP: log_intent anchors a task and returns a unique task email address, reversibility says how undoable an action is before the agent acts, review compares the receipts and Stripe charges that reached the task inbox with the intent and returns exact mismatches, undo fixes the agent's own mismatched actions, and get_chain and list_chains show open chains. Proxy also runs as a recovery agent with its own Inkbox identity: it captures confirmations (structured data first, an LLM only for messy emails) and Stripe events, keeps watching after the agent's session ends, groups related mistakes into one chain, and sends the human one text (reply UNDO ALL, PICK or KEEP), escalating to iMessage and a phone call before the deadline. It undoes the chain cheapest and most urgent first using reversibility rules (the 24-hour flight rule, hotel free-cancellation deadline, subscription refund window) and a damage minimizer, negotiating with merchant agents over Inkbox A2A with the Reversal Protocol (a state machine: request_reversal, accept, counter or deny, accept, push back once or ask the human; at most 3 rounds and a hard deadline), or emailing support, following up, calling and filing a Stripe dispute when a merchant has no agent. A refund only counts when Stripe shows it. Then Proxy hands the corrected intent back to the original agent to redo it, and records the lesson in a mistakes MCP resource. An MCP App shows the live undo chain. Merchant messages are untrusted data. Merchants and merchant agents in our demo are our own mocks and the clock is simulated; never claim otherwise. We prove it with a scoreboard: about 30 scripted scenarios run against a naive arm (the agent checking its own work) and against Proxy, and we report mistakes caught, chain completeness, money recovered, redo correctness, false done claims, time to alert and token cost. We only report numbers our actual runs produce. Full docs are in docs/ (start with docs/01-concepts.md and docs/04-architecture.md).

Hackathon: YC Make Something Agents Want. Submissions due Sunday 10 AM. Target tracks: Manufact (MCP server) and Inkbox (agent identity: email, text, phone, agent to agent).

## Stack
TypeScript, Node 18+, mcp-use (Manufact), @inkbox/sdk, Stripe in test mode only, Supabase, @anthropic-ai/sdk.

## Three people work in this folder at the same time, each with their own coding agent
Karan owns: src/server.ts, src/tools/, src/app/ (MCP App), src/stripe/, src/orchestrator/, src/types.ts (the shared contract), package.json, tsconfig.json.
Sarah owns: src/inkbox/, src/capture/, src/db/, src/web/.
Dhwanil owns: src/logic/, src/merchants/, evals/, fixtures/, tests/.

## Karan's two agents
Karan's area is split between two coding agents. Each edits only its own part.
- Agent 1 owns: src/types.ts, src/server.ts, src/tools/, src/orchestrator/ (including the simulated clock), src/app/, package.json, tsconfig.json.
- Agent 2 owns: src/stripe/, src/agent/.
Agent 2 asks for package.json or src/types.ts changes under "Karan" in HANDOFF.md. Agent 1 asks for src/stripe/ or src/agent/ changes under "Karan's Codex".

Rules:
- Only edit files in your own area. Anyone may read src/types.ts but only Karan edits it, and after the Saturday 12:30 PM freeze a change needs all three people to agree.
- If you need a change in someone else's area, or a new npm package, add a note under their heading in HANDOFF.md and stop. Only Karan edits package.json.
- Use short-lived branches named after yourself (karan/..., sarah/..., dhwanil/...), merge to main often, and keep main running.
- Commit only your own files with explicit paths (git add src/logic/...). Never use git add ., git add -A, git reset --hard, git checkout ., git stash, or force push.
- Prefix commit messages with [core] for src/ work or [evals] for evals/, fixtures/ and tests/ work. Never mention Claude, Codex, AI or any assistant in commit messages, PR titles, PR descriptions or code comments. No Co-Authored-By or Generated-with lines. Run git pull --rebase before you push.
- Secrets go in .env, which is never committed. Add every variable name to .env.example.

## How to work
- Hackathon speed: small working increments, demo path first. No coverage targets. Write tests only where they protect the demo.
- The functions in src/logic/ are pure and take the current time as an argument, so they run on the simulated clock.
- When you finish a task, reply with: files changed, how to run it, what is left.
