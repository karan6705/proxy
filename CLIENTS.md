# Add Proxy to your MCP client

## Try it in 60 seconds

1. Add the server to your client (the two snippets below).
2. Ask your agent: *"Call Proxy's `try_proxy_demo` tool."* It runs the whole story in a simulated sandbox in about a second: an agent books a trip for the wrong dates, Proxy alerts a (simulated) human, who replies UNDO ALL, Proxy negotiates the hotel down to an 85% refund, gets the transfer refunded and the host corrected, and the agent rebooks. It returns a `chain_id` and a plain-English summary.
3. Call `get_chain` with that `chain_id`: every action, what was refunded, and that it is confirmed. In clients that show MCP Apps, the live-chain view renders too. `list_chains` lists every sandbox chain (a finished example, `sandbox_example`, is always there).

Proxy is a remote MCP server (streamable HTTP). You need its URL:

- Cloud judge copy: `https://bold-zero-0m4lf.run.mcp-use.com/mcp` (simulated: no real money, messages or merchants)
- Local: `http://localhost:3000/mcp` (`npm run dev`), or the public URL that `npm run dev -- --tunnel` prints, plus `/mcp`

## Claude Code

```bash
claude mcp add --transport http proxy https://bold-zero-0m4lf.run.mcp-use.com/mcp
# add --scope user to have it in every project
claude mcp list        # proxy should show as connected
```

In a session, run `/mcp` to see its tools, or ask: "Use Proxy's undo_my_agents_mistake prompt for: book my NYC trip for the Nov 13 conference, under $1,500."

## Cursor

Add this to `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "proxy": {
      "url": "https://bold-zero-0m4lf.run.mcp-use.com/mcp"
    }
  }
}
```

Then open Settings > MCP and check that `proxy` is on, with its tools.

## Check it works

Call `log_intent` with:

```json
{ "goal": "NYC trip for the Nov 13 conference, under $1,500", "constraints": { "dates": { "start": "2026-11-13", "end": "2026-11-16" }, "budget_total": 150000 }, "idempotency_key": "try-1" }
```

You get back a `task_id` and a `task_email`. Then call `review` with that `task_id`: it returns `status: "clean"`, because nothing has been booked yet.
