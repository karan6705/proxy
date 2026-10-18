// npm run demo:stage: gets the live demo ready on the running server (MCP_URL, default Karan's port 3000).
//   1. Checks every variable the live demo needs, by name only (OK / MISSING; values are never printed).
//   2. Starts the hotel agent (demo:hotel) unless one is already running.
//   3. Resets the demo (a fresh task id; earlier runs expire).
//   4. Prints the URLs to open. Then run `npm run demo:go` to make the agent's mistake.
// It stays running while it owns the hotel agent; Ctrl+C stops both.
import { spawn, execSync } from "node:child_process";
import { resetDemo } from "../src/agent/reset.js";
import { baseUrl, printUrls, waitForHealth } from "./demo-common.js";

const env = process.env;
const has = (name: string) => Boolean(env[name]?.trim());
const checks: Array<[string, boolean, string?]> = [
  ["STRIPE_SECRET_KEY", has("STRIPE_SECRET_KEY") && env.STRIPE_SECRET_KEY!.startsWith("sk_test_"), "must be a Stripe test key"],
  ["INKBOX_API_KEY", has("INKBOX_API_KEY")],
  ["INKBOX_PROXY_API_KEY", has("INKBOX_PROXY_API_KEY")],
  ["INKBOX_HOTEL_AGENT_API_KEY", has("INKBOX_HOTEL_AGENT_API_KEY")],
  ["HUMAN_PHONE", has("HUMAN_PHONE")],
  ["INKBOX_WEBHOOK_TOKEN or INKBOX_WEBHOOK_SECRET", has("INKBOX_WEBHOOK_TOKEN") || has("INKBOX_WEBHOOK_SECRET")],
];
let missing = 0;
for (const [name, ok, why] of checks) {
  console.log(`${ok ? "OK     " : "MISSING"} ${name}${!ok && why ? ` (${why})` : ""}`);
  if (!ok) missing += 1;
}
console.log(`${has("SUPABASE_URL") ? "OK     " : "SKIPPED"} SUPABASE_URL (optional: without it runs are kept in memory)`);
if (missing) {
  console.error(`\n${missing} required variable(s) missing in .env. For a recording without them, use npm run demo:offline-stage.`);
  process.exit(1);
}

const mcpUrl = env.MCP_URL ?? "http://localhost:3000/mcp";
const origin = baseUrl(mcpUrl);
if (!(await waitForHealth(origin, 5000))) {
  console.error(`No server at ${origin}. Start it first: npm run dev -- --tunnel (with PROXY_DEMO_ROUTES=1).`);
  process.exit(1);
}
console.log(`OK      server at ${origin}`);

let hotel: ReturnType<typeof spawn> | null = null;
let running = false;
try {
  running = execSync("pgrep -f scripts/hotel-agent.ts || true").toString().trim() !== "";
} catch {
  running = false;
}
if (running) {
  console.log("OK      hotel agent already running (left as is)");
} else {
  hotel = spawn("npx", ["tsx", "--env-file-if-exists=.env", "scripts/hotel-agent.ts"], { stdio: "inherit", env: { ...env, MCP_URL: mcpUrl } });
  console.log("OK      hotel agent started");
}

await resetDemo({ mcpUrl });
console.log("OK      demo reset: a fresh run, earlier runs expired");
printUrls(origin, "live: real Stripe test mode, real Inkbox, real texts");
console.log("Next: npm run demo:go");

if (hotel) {
  const stop = () => {
    hotel?.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Keeping the hotel agent running. Ctrl+C to stop it.");
  setInterval(() => {}, 60_000);
}
