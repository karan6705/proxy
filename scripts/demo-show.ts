// npm run demo:show: prints the /web/show URLs for the running server (MCP_URL, default Karan's port 3000).
import { SCENARIO_NAMES } from "../src/agent/scenarios.js";
import { baseUrl } from "./demo-common.js";

const origin = baseUrl(process.env.MCP_URL ?? "http://localhost:3000/mcp");
console.log(`
Presentation page: ${origin}/web/show
  It follows the live run. With no run yet it shows the story picker.

Present a story (starts paused; Space or Right arrow for the next step, Left to go back):`);
for (const s of SCENARIO_NAMES) console.log(`  ${s.padEnd(10)} ${origin}/web/show?present=1&scenario=${s}`);
console.log(`
Play a story by itself (a recorded run with simulated payments):`);
for (const s of SCENARIO_NAMES) console.log(`  ${s.padEnd(10)} ${origin}/web/show?scenario=${s}`);
console.log(`
Run a story live (reset first, then the agent's part; reply on the page's phone or by text):
  npm run demo:reset && npm run demo:go -- --scenario trip|ambiguous|plan
`);
