# Tripwire: rules for every agent in this repo

## What we are building
Tripwire is an MCP server that lets any AI agent buy what it needs (API credits, a domain, a SaaS seat) through Stripe, within a budget the human sets. Under budget it buys instantly. Over budget, the agent emails the human through Primitive with a signed approve link, waits, then completes the purchase. It also catches the ways agents overspend: hidden text on product pages telling the agent to buy more, splitting one big purchase into small ones to dodge the limit, and buying things unrelated to the task. We prove it with a scoreboard: the same agent runs about 30 scripted scenarios against a naive server and against Tripwire, and we compare unauthorized spend, needless escalations and token cost. We only report numbers our actual runs produce.

Hackathon: YC Make Something Agents Want. Submissions due Sunday 10 AM. Target tracks: Manufact (MCP server), Stripe (safe agent spending), Primitive (email approval), Armature (agent experience).

## Stack
TypeScript, Node 18+, official MCP TypeScript SDK, Stripe in test mode only, Primitive for email.

## Two agents work in this folder at the same time
Claude Code owns: src/ (server, tools, policy engine, Stripe and Primitive integrations), src/types.ts (the shared contract), package.json, tsconfig.json.
Codex owns: evals/ (scenarios, naive baseline server, runner, scoreboard), fixtures/ (malicious product pages and test data), tests/.

Rules:
- Only edit files in your own area. Codex may read src/types.ts but never edits it.
- If you need a change in the other agent's area, or a new npm package, add a note under the other agent's heading in HANDOFF.md and stop. Only Claude Code edits package.json.
- Commit only your own files with explicit paths (git add src/...). Never use git add ., git add -A, git reset --hard, git checkout ., git stash, or force push.
- Prefix commit messages with [core] for src/ work or [evals] for evals/, fixtures/ and tests/ work. Never mention Claude, Codex, AI or any assistant in commit messages, PR titles, PR descriptions or code comments. No Co-Authored-By or Generated-with lines. Run git pull --rebase before you push.
- Secrets go in .env, which is never committed. Add every variable name to .env.example.

## How to work
- Hackathon speed: small working increments, demo path first. No coverage targets. Write tests only where they protect the demo.
- When you finish a task, reply with: files changed, how to run it, what is left.
