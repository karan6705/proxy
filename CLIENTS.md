# Add Proxy to your MCP client

Proxy is a remote MCP server (streamable HTTP). You need its URL:

- Deployed: `https://<DEPLOYED_URL>/mcp` (Sarah posts it in HANDOFF.md once the Manufact deploy is up)
- Local: `http://localhost:3000/mcp` (`npm run dev`), or the public URL that `npm run dev -- --tunnel` prints, plus `/mcp`

## Claude Code

```bash
claude mcp add --transport http proxy https://<DEPLOYED_URL>/mcp
# add --scope user to have it in every project
claude mcp list        # proxy should show as connected
```

In a session, run `/mcp` to see its six tools, or ask: "Use Proxy's undo_my_agents_mistake prompt for: book my NYC trip for the Nov 13 conference, under $1,500."

## Cursor

Add this to `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "proxy": {
      "url": "https://<DEPLOYED_URL>/mcp"
    }
  }
}
```

Then open Settings > MCP and check that `proxy` is on, with 6 tools.

## Check it works

Call `log_intent` with:

```json
{ "goal": "NYC trip for the Nov 13 conference, under $1,500", "constraints": { "dates": { "start": "2026-11-13", "end": "2026-11-16" }, "budget_total": 150000 }, "idempotency_key": "try-1" }
```

You get back a `task_id` and a `task_email`. Then call `review` with that `task_id`: it returns `status: "clean"`, because nothing has been booked yet.
