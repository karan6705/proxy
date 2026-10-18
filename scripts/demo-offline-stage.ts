// npm run demo:offline-stage: the whole story with no network, for recording if the wifi or Inkbox fails.
// Starts its own server (default port 3001; STAGE_PORT to change) with Inkbox in dry-run, payments simulated
// (every text says "Stripe (simulated)", never plain Stripe) and runs in memory. Then: reset, the agent's mistake,
// the alert, a fake human reply UNDO ALL after 5 seconds, the hotel negotiation, the summary and the redo.
// The server keeps running for the recording; Ctrl+C stops it.
import { spawn } from "node:child_process";
import { runRehearsal } from "../src/agent/rehearse.js";
import { resetDemo } from "../src/agent/reset.js";
import { printUrls, waitForHealth } from "./demo-common.js";

const port = Number(process.env.STAGE_PORT ?? 3001);
const origin = `http://localhost:${port}`;
const mcpUrl = `${origin}/mcp`;
const offlineEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(port),
  MCP_URL: mcpUrl,
  PROXY_DEMO_ROUTES: "1",
  INKBOX_DRY_RUN: "1",
  PROXY_PROTOCOL_LOOPBACK: "1",
  PROXY_SIMULATED_PAYMENTS: "1",
  STRIPE_SECRET_KEY: "",
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  SUPABASE_KEY: "",
  HUMAN_PHONE: "",
};
// This process too: the scripted agent must not reach Stripe.
for (const [k, v] of Object.entries(offlineEnv)) process.env[k] = v;

if (await waitForHealth(origin, 1000)) {
  console.error(`Port ${port} is already in use. Stop that server or set STAGE_PORT.`);
  process.exit(1);
}
const server = spawn("npx", ["mcp-use", "dev", "--entry", "src/server.ts", "--views-dir", "src/app"], { env: offlineEnv, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => {
  server.kill("SIGINT");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (!(await waitForHealth(origin, 60_000))) {
  console.error("The offline server did not start.");
  stop();
}
console.log(`Offline server up at ${origin} (Inkbox dry-run, simulated payments, in memory).`);
printUrls(origin, "OFFLINE: Inkbox dry-run, simulated payments, fake human reply");
console.log("Open the stage page now. The story starts in 5 seconds.\n");
await new Promise((r) => setTimeout(r, 5000));

await resetDemo({ mcpUrl, env: offlineEnv });
const result = await runRehearsal({ mcpUrl, reset: async () => undefined, human: true, replyDelayMs: 5000 });
console.log(result.passed ? "\nThe whole story ran. The server stays up for the recording; Ctrl+C to stop." : "\nSomething failed; see the lines above. Ctrl+C to stop.");
setInterval(() => {}, 60_000);
