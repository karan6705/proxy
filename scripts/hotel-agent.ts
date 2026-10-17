// The hotel's side of the Reversal Protocol on real Inkbox, for end-to-end demo runs.
// Polls hotel-agent's A2A tasks and email for Proxy's messages and answers each through the running server's
// mock hotel (POST /merchants/hotel/agent), which holds the bookings. Run next to the server:
//   MCP_URL=http://localhost:3000/mcp npm run demo:hotel
// Needs INKBOX_API_KEY and INKBOX_HOTEL_AGENT_API_KEY (A2A rejects the admin key). Keys are never printed.
import { createA2AAccess, createClient, createMerchantBridge } from "../src/inkbox/index.js";
import type { MerchantProtocolMessage } from "../src/types.js";

const env = process.env;
const base = new URL(env.MCP_URL ?? "http://localhost:3000/mcp");
const agentUrl = new URL("/merchants/hotel/agent", base);
const proxyHandle = env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent";

if (!env.INKBOX_API_KEY?.trim()) {
  console.error("INKBOX_API_KEY is not set");
  process.exit(1);
}

const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now(), mode: "real" as const };
const bridge = createMerchantBridge({
  access: createA2AAccess({ admin: createClient, handle: "hotel-agent", apiKey: env.INKBOX_HOTEL_AGENT_API_KEY?.trim() || undefined }),
  agent: {
    merchant_id: "hotel",
    async respond(message) {
      const res = await fetch(agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!res.ok) throw new Error(`hotel agent route answered ${res.status}`);
      return (await res.json()) as MerchantProtocolMessage;
    },
  },
  clock,
  proxyHandle,
  proxyEmail: `${proxyHandle}@inkboxmail.com`,
  log: (line) => console.log(`[hotel-agent] ${line}`),
});
bridge.start();
console.log(`hotel-agent bridge polling; answers via ${agentUrl.origin}`);
