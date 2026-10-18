// npm run demo:go [-- --scenario trip|ambiguous|plan|store]: the buying agent's part of a story against the running server
// (MCP_URL). trip (the default): it logs the intent, books with the wrong date, emails the host, reviews, undoes the
// flight in its session, leaves, and the late confirmations arrive; the alert fires a few seconds later.
// ambiguous, plan and store: see src/agent/scenarios.ts. Run npm run demo:stage (live) or reset the demo first.
import { createHttpMerchants } from "../src/agent/http-merchants.js";
import { connectToolClient } from "../src/agent/mcp-client.js";
import { runRehearsal } from "../src/agent/rehearse.js";
import { runAmbiguousAgent, runPlanAgent, runStoreAgent, SCENARIO_NAMES, type ScenarioName } from "../src/agent/scenarios.js";
import { createDemoClock, createHttpDemoControl } from "../src/agent/scripted.js";

const args = process.argv.slice(2);
const flag = args.indexOf("--scenario");
const scenario = (flag >= 0 ? args[flag + 1] : args.find((a) => a.startsWith("--scenario="))?.slice(11)) ?? "trip";
if (!SCENARIO_NAMES.includes(scenario as ScenarioName)) {
  console.error(`--scenario must be one of ${SCENARIO_NAMES.join(", ")}`);
  process.exit(1);
}
const mcpUrl = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const origin = new URL(mcpUrl).origin;

if (scenario === "trip") {
  const result = await runRehearsal({ mcpUrl, reset: async () => undefined, human: false });
  if (!result.passed) process.exitCode = 1;
  else console.log(`\nThe alert goes to the human in a few seconds. Reply UNDO ALL by text, or tap it on ${origin}/web/show.`);
} else {
  const client = await connectToolClient(mcpUrl);
  try {
    const options = {
      client,
      // The plan's receipt arrives late, after the agent has left; the trip's and the ambiguous story's hotel too.
      merchants: createHttpMerchants(mcpUrl, fetch, (id) => id === "hotel" || id === "saas" || id === "northwind"),
      control: createHttpDemoControl(mcpUrl),
      // The same demo clock the trip agent uses (the server is reset to it), so refund windows line up.
      now: createDemoClock().now,
    };
    const r = scenario === "ambiguous" ? await runAmbiguousAgent(options) : scenario === "store" ? await runStoreAgent(options) : await runPlanAgent(options);
    console.log(`Done (${r.task_id}). Watch it on ${origin}/web/show`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
