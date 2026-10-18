// The hotel's side of the Reversal Protocol on real Inkbox, for end-to-end demo runs.
// Polls hotel-agent's A2A tasks and email for Proxy's messages and answers each through the running server's
// mock hotel (POST /merchants/hotel/agent), which holds the bookings. Run next to the server:
//   MCP_URL=http://localhost:3000/mcp npm run demo:hotel
// Needs INKBOX_API_KEY and INKBOX_HOTEL_AGENT_API_KEY (A2A rejects the admin key). Keys are never printed.
import { createA2AAccess, createClient, createMerchantBridge } from "../src/inkbox/index.js";
import { colorEnabled, narrateExchange } from "../src/merchants/index.js";
import { createRateLimitState, guardAccess, schedulePolls, throttledLog } from "../src/orchestrator/poll-guard.js";
import type { MerchantProtocolMessage } from "../src/types.js";

const env = process.env;
const base = new URL(env.MCP_URL ?? "http://localhost:3000/mcp");
const agentUrl = new URL("/merchants/hotel/agent", base);
const proxyHandle = env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent";

if (env.INKBOX_DRY_RUN === "1") {
  console.error("demo:hotel polls real Inkbox, so it doesn't run with INKBOX_DRY_RUN=1 (in dry-run the server's mock hotel answers in-process).");
  process.exit(1);
}
const missing = ["INKBOX_API_KEY", "INKBOX_HOTEL_AGENT_API_KEY"].filter((name) => !env[name]?.trim());
if (missing.length) {
  console.error(`demo:hotel needs ${missing.join(" and ")} in .env (A2A rejects the admin key, so the hotel needs its own).`);
  process.exit(1);
}

// Inkbox allows 600 requests a minute per key: poll at most every 3 s and back off on 429.
const limit = createRateLimitState();
const log = throttledLog((line) => console.log(`[hotel-agent] ${line}`));
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now(), mode: "real" as const };
const bridge = createMerchantBridge({
  access: guardAccess(createA2AAccess({ admin: createClient, handle: "hotel-agent", apiKey: env.INKBOX_HOTEL_AGENT_API_KEY?.trim() || undefined }), limit),
  agent: {
    merchant_id: "hotel",
    async respond(message) {
      const res = await fetch(agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!res.ok) {
        console.error(`[hotel-agent] ${message.type} round ${message.round} (${message.negotiation_id}): server answered ${res.status}`);
        throw new Error(`hotel agent route answered ${res.status}`);
      }
      const answer = (await res.json()) as MerchantProtocolMessage;
      // Dhwanil's speaker-labelled lines ("Proxy: ...", "Hotel: ..."), the same story as the stage page.
      for (const line of narrateExchange(message, answer, { color: colorEnabled(), style: "speakers", merchant: "Hotel" })) console.log(line);
      return answer;
    },
  },
  clock,
  // Pick up requests Proxy sent before the bridge started (default: the last 30 minutes). Open A2A tasks are
  // answered once; closed ones never again.
  since: env.HOTEL_AGENT_SINCE?.trim() || new Date(Date.now() - 30 * 60_000).toISOString(),
  proxyHandle,
  proxyEmail: `${proxyHandle}@inkboxmail.com`,
  log: (line) => (/rate limit|429/i.test(line) ? undefined : log(line)),
});
const schedule = schedulePolls({ pollOnce: () => bridge.pollOnce(), state: limit, log });
console.log(`Harborview Hotel agent (hotel-agent) is listening for Proxy on Inkbox A2A and email. Answers come from ${agentUrl.origin}. Ctrl+C to stop.`);

// The poll timer doesn't hold the process open on its own, so keep it alive until Ctrl+C.
const keepAlive = setInterval(() => {}, 60_000);
const stop = () => {
  schedule.stop();
  clearInterval(keepAlive);
  console.log("hotel-agent bridge stopped");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
