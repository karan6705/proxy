// Live check after the cutover to the deployed server:
//   npx tsx --env-file=.env src/inkbox/cutover-check.ts https://<deployed-host> [--no-send]
// 1 MCP initialize and tools/list  2 webhook auth (token accepted, no token refused)  3 subscriptions point at the deployed URL
// 4 send one alert to HUMAN_PHONE  5 wait for you to reply UNDO ALL  6 find the webhook delivery in Inkbox's log and
// check it got a 2xx from the deployed server. Prints last four digits of the number only, never a token.
import { composeChainAlert } from "./alert.js";
import { createInkbox } from "./client.js";
import { findDelivery, isOk, subscriptionProblems } from "./cutover.js";
import { parseReply } from "./reply.js";
import { createClient } from "./sdk.js";
import { INBOUND_PATHS, listSubscriptions } from "./subscriptions.js";

const args = process.argv.slice(2);
const base = args.find((a) => /^https:\/\//.test(a))?.replace(/\/+$/, "");
if (!base) {
  console.error("usage: cutover-check.ts https://<deployed-host> [--no-send]");
  process.exit(1);
}
const send = !args.includes("--no-send");
const token = process.env.INKBOX_WEBHOOK_TOKEN?.trim();
const human = process.env.HUMAN_PHONE?.trim();
const channel = process.env.HUMAN_ALERT_CHANNEL === "sms" ? "sms" : "imessage";
let failed = 0;
const line = (ok: boolean | null, name: string, detail = "") => {
  if (ok === false) failed += 1;
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ event_type: "noop" }), signal: AbortSignal.timeout(15_000) });

// 1. It is our server. Manufact's gateway answers /health itself, so a 200 there proves nothing; the MCP endpoint does.
const EXPECTED_TOOLS = ["log_intent", "reversibility", "review", "undo", "get_chain", "list_chains"];
async function mcp(method: string, params: unknown, id: number): Promise<{ result?: { serverInfo?: { name?: string }; tools?: { name: string }[] } }> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
  return JSON.parse(data);
}
try {
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cutover-check", version: "1" } }, 1);
  line(init.result?.serverInfo?.name === "proxy", "MCP initialize answers as the Proxy server", String(init.result?.serverInfo?.name));
  const tools = (await mcp("tools/list", {}, 2)).result?.tools?.map((t) => t.name) ?? [];
  const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
  line(missing.length === 0, "tools/list returns all six tools", missing.length ? `missing ${missing.join(", ")}` : tools.join(", "));
} catch (e) {
  line(false, "MCP endpoint", (e as Error).message);
}

// 2. Webhook auth.
if (!token) line(false, "webhook auth", "INKBOX_WEBHOOK_TOKEN is not set here");
else {
  try {
    const good = await post("/inkbox/text", { authorization: `Bearer ${token}` });
    line(good.status === 200, "webhook with the token is accepted", String(good.status));
    const bad = await post("/inkbox/text");
    line(bad.status === 401, "webhook without the token is refused", bad.status === 200 ? "200: INKBOX_DRY_RUN is set on the server, it must not be" : String(bad.status));
  } catch (e) {
    line(false, "webhook auth", (e as Error).message);
  }
}

// 3. Subscriptions.
const inkbox = await createClient();
const subs = await listSubscriptions(inkbox);
const problems = subscriptionProblems(subs, base, [...INBOUND_PATHS]);
line(problems.length === 0, "Inkbox subscriptions point at the deployed URL", problems.join("; "));

// 4 to 6. A real alert and a real reply.
if (!send) line(null, "alert, reply and delivery log", "--no-send");
else if (!human) line(false, "alert, reply and delivery log", "HUMAN_PHONE is not set here");
else {
  const last4 = human.slice(-4);
  const sentAt = Date.now();
  await createInkbox().sendText(
    channel,
    human,
    composeChainAlert({ what_went_wrong: "used the wrong date (Nov 3, not Nov 13)", affected: 4, money_at_risk: 124000, time_left_ms: (3 * 60 + 40) * 60_000 }),
  );
  line(true, `alert sent by ${channel} to ***${last4}`);
  console.log("      Reply UNDO ALL on that phone now (waiting up to 3 minutes)...");

  const proxy = await inkbox.getIdentity(process.env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent");
  let repliedAt = 0;
  for (let i = 0; i < 36 && !repliedAt; i += 1) {
    await sleep(5000);
    const texts = (await proxy.listTexts({ limit: 10 }).catch(() => [])) as { direction: string; text: string | null; createdAt: string }[];
    const ims = (await proxy.listIMessages({ limit: 10 }).catch(() => [])) as { direction: string; content: string | null; createdAt: string }[];
    const inbound = [...texts.map((t) => ({ d: t.direction, body: t.text, at: t.createdAt })), ...ims.map((m) => ({ d: m.direction, body: m.content, at: m.createdAt }))];
    const hit = inbound.find((m) => m.d !== "outbound" && Date.parse(m.at) >= sentAt && parseReply(m.body ?? "").kind === "undo_all");
    if (hit) repliedAt = Date.parse(hit.at);
  }
  line(repliedAt > 0, "UNDO ALL reached Inkbox", repliedAt ? new Date(repliedAt).toISOString() : "not seen in 3 minutes");

  if (repliedAt) {
    await sleep(4000);
    const rows = await inkbox.webhooks.deliveries.list({ limit: 30 });
    const d = findDelivery(rows, { since: sentAt, baseUrl: base, eventTypes: ["imessage.received", "text.received"] });
    if (!d) line(false, "webhook delivery to the deployed server", "no delivery to that URL in Inkbox's log; check the subscriptions");
    else line(isOk(d.responseStatus), `Inkbox's delivery of ${d.eventType} got a response`, `${d.responseStatus ?? "none"}${d.errorDetail ? ` (${d.errorDetail})` : ""}`);
    console.log("      The server also answers the human by text. With no open chain the reply is \"Nothing is waiting on you right now.\"");
  }
}
console.log(failed ? `\n${failed} check(s) FAILED. If the deployed URL is not working, run the rollback in HANDOFF.md.` : "\nAll checks passed. For the server's own logs: npx mcp-use deployments logs <deployment-id>");
process.exit(failed ? 1 : 0);
