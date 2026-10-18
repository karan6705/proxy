// The hotel's side of the Reversal Protocol on real Inkbox, for end-to-end demo runs.
// Polls hotel-agent's A2A tasks and email for Proxy's messages and answers each through the running server's
// mock hotel (POST /merchants/hotel/agent), which holds the bookings. Run next to the server:
//   MCP_URL=http://localhost:3000/mcp npm run demo:hotel
// Needs INKBOX_API_KEY and INKBOX_HOTEL_AGENT_API_KEY (A2A rejects the admin key). Keys are never printed.
import { createA2AAccess, createClient, createMerchantBridge } from "../src/inkbox/index.js";
import type { MerchantProtocolMessage, ProxyProtocolMessage } from "../src/types.js";
import { merchantLine, money } from "../src/orchestrator/copy.js";

const tty = process.stdout.isTTY;
const color = { in: tty ? "\x1b[36m" : "", out: tty ? "\x1b[32m" : "", dim: tty ? "\x1b[2m" : "", off: tty ? "\x1b[0m" : "" };
const orderAmounts = new Map<string, number>();

function proxyAsks(m: ProxyProtocolMessage): string {
  if (m.type === "request_reversal") return `please cancel ${m.order.ref} and refund ${money(m.order.amount)} (${m.what_went_wrong})`;
  if (m.type === "push_back") return "no store credit, per our human's preferences; asking for a refund";
  if (m.type === "accept_counter") return "we accept your offer";
  return "checking with our human";
}

const env = process.env;
const base = new URL(env.MCP_URL ?? "http://localhost:3000/mcp");
const agentUrl = new URL("/merchants/hotel/agent", base);
const proxyHandle = env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent";

const missing = ["INKBOX_API_KEY", "INKBOX_HOTEL_AGENT_API_KEY"].filter((name) => !env[name]?.trim());
if (missing.length) {
  console.error(`demo:hotel needs ${missing.join(" and ")} in .env (A2A rejects the admin key, so the hotel needs its own).`);
  process.exit(1);
}

const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now(), mode: "real" as const };
const bridge = createMerchantBridge({
  access: createA2AAccess({ admin: createClient, handle: "hotel-agent", apiKey: env.INKBOX_HOTEL_AGENT_API_KEY?.trim() || undefined }),
  agent: {
    merchant_id: "hotel",
    async respond(message) {
      const res = await fetch(agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!res.ok) {
        console.error(`[hotel-agent] ${message.type} round ${message.round} (${message.negotiation_id}): server answered ${res.status}`);
        throw new Error(`hotel agent route answered ${res.status}`);
      }
      const answer = (await res.json()) as MerchantProtocolMessage;
      const time = new Date().toTimeString().slice(0, 8);
      const amount = message.type === "request_reversal" ? message.order.amount : (orderAmounts.get(message.negotiation_id) ?? 0);
      if (message.type === "request_reversal") orderAmounts.set(message.negotiation_id, message.order.amount);
      // The same plain-English lines as the stage page, so both agents' sides can be shown side by side.
      console.log(`${time}  ${color.dim}round ${message.round}${color.off}  ${color.in}Proxy  ${color.off}${proxyAsks(message)}`);
      console.log(`${time}  ${color.dim}round ${answer.round}${color.off}  ${color.out}Hotel  ${color.off}${merchantLine("Harborview Hotel agent", answer, amount).replace(/^Harborview Hotel agent: /, "")}`);
      return answer;
    },
  },
  clock,
  // Pick up requests Proxy sent before the bridge started (default: the last 30 minutes). Open A2A tasks are
  // answered once; closed ones never again.
  since: env.HOTEL_AGENT_SINCE?.trim() || new Date(Date.now() - 30 * 60_000).toISOString(),
  proxyHandle,
  proxyEmail: `${proxyHandle}@inkboxmail.com`,
  log: (line) => console.log(`[hotel-agent] ${line}`),
});
bridge.start();
console.log(`Harborview Hotel agent (hotel-agent) is listening for Proxy on Inkbox A2A and email. Answers come from ${agentUrl.origin}. Ctrl+C to stop.`);

// The bridge's poll timer doesn't hold the process open on its own, so keep it alive until Ctrl+C.
const keepAlive = setInterval(() => {}, 60_000);
const stop = () => {
  bridge.stop();
  clearInterval(keepAlive);
  console.log("hotel-agent bridge stopped");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
