// npm run demo:go: the buying agent's part of the story against the running server (MCP_URL): it logs the
// intent, books with the wrong date, emails the host, reviews, undoes the flight in its session, leaves, and
// the late confirmations arrive. The alert fires a few seconds later. Run npm run demo:stage first.
import { runRehearsal } from "../src/agent/rehearse.js";

const result = await runRehearsal({ mcpUrl: process.env.MCP_URL ?? "http://localhost:3000/mcp", reset: async () => undefined, human: false });
if (!result.passed) process.exitCode = 1;
else console.log("\nThe alert goes to the human in a few seconds. Reply UNDO ALL by text, or use the demo page.");
