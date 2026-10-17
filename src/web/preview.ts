// Look at the demo page with fake data: npx tsx src/web/preview.ts, then open http://localhost:4173/web
// Buttons post through the same human channel a text does; replies are printed here instead of sent.
import { createServer } from "node:http";
import { createMemoryStore } from "../db/memory.js";
import { createHumanChannel } from "../inkbox/human.js";
import type { Action, Chain, Clock } from "../types.js";
import { createWebRoutes } from "./routes.js";

const clock: Clock = { mode: "real", now: () => new Date().toISOString(), nowMs: () => Date.now() };
const store = createMemoryStore();
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const actions: Action[] = [
  { action_id: "a1", task_id: "t1", merchant: "airline", category: "flight", summary: "Flight SFO to JFK on 2026-11-03", amount: 41200, ref: "AIR-1", source: "email", received_at: iso(now), state: "found" },
  { action_id: "a2", task_id: "t1", merchant: "hotel", category: "hotel", summary: "Harborview Hotel, King room, 2026-11-03 to 2026-11-06", amount: 64000, ref: "HTL-1", source: "email", received_at: iso(now), state: "found" },
  { action_id: "a3", task_id: "t1", merchant: "transfer", category: "transfer", summary: "Transfer JFK to Harborview Hotel on 2026-11-03", amount: 18800, ref: "TRF-1", source: "email", received_at: iso(now), state: "found" },
];
for (const a of actions) await store.upsertAction(a);
const chain: Chain = {
  chain_id: "c1", task_id: "t1", root_action_id: "a1", action_ids: ["a1", "a2", "a3"], money_at_risk: 124000,
  window_ends_at: iso(now + (3 * 60 + 40) * 60_000), state: "alerted",
  alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: iso(now) }], plan: [], steps: [],
};
await store.upsertChain(chain);
for (const [kind, outcome] of [["email_in", "captured:jsonld"], ["email_in", "captured:jsonld"], ["email_in", "captured:jsonld"], ["sms_out", "dry_run"]] as const)
  await store.logEvent({ run_id: "preview", arm: "proxy", scenario_id: "preview", layer: "scripted", kind, tool_name: null, task_id: "t1", chain_id: null, action_id: null, outcome, tokens_in: null, tokens_out: null, timestamp: iso(Date.now()) });

const HUMAN = "+15550000000";
const channel = createHumanChannel({
  store, clock, humanNumber: HUMAN,
  hooks: { onHumanReply: async (r) => {
    console.log("onHumanReply:", JSON.stringify(r));
    // Pretend the orchestrator ran: UNDO ALL / PICK mark things verified, one at a time.
    if (r.kind === "keep") await store.upsertChain({ ...chain, state: "kept" });
    else if (r.kind === "undo_all" || r.kind === "pick") {
      await store.upsertChain({ ...chain, state: "undoing" });
      const picked = r.kind === "pick" ? r.picks.map((n) => actions[n - 1]) : actions;
      picked.forEach((a, i) => setTimeout(() => void store.upsertAction({ ...a, state: "verified" }), 1500 * (i + 1)));
    }
  } },
  sendText: async (_c, _to, body) => (console.log("text to human:", body), { message_id: "preview" }),
});
const routes = createWebRoutes({ store, clock, channel, humanNumber: HUMAN, controls: true });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (!route) { res.writeHead(404).end("not found"); return; }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const out = await route.handle({ method: req.method as "GET", path: url.pathname, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), query: {}, rawBody: Buffer.concat(chunks).toString() });
  const body = out.body === undefined ? "" : typeof out.body === "string" ? out.body : JSON.stringify(out.body);
  res.writeHead(out.status, { ...(typeof out.body === "object" ? { "content-type": "application/json" } : {}), ...out.headers }).end(body);
}).listen(4173, () => console.log("Demo page preview: http://localhost:4173/web"));
