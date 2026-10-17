import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/memory.js";
import { createHumanChannel } from "../inkbox/human.js";
import type { Chain, Clock, HumanReply } from "../types.js";
import { createWebRoutes } from "./index.js";
import { PAGE_HTML } from "./page.js";

const now = "2026-11-01T10:00:00.000Z";
const clock: Clock = { mode: "simulated", now: () => now, nowMs: () => Date.parse(now) };
const chain: Chain = {
  chain_id: "c1", task_id: "t1", root_action_id: "a1", action_ids: ["a1"], money_at_risk: 41200,
  window_ends_at: "2026-11-01T14:00:00.000Z", state: "alerted",
  alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-11-01T09:00:00.000Z" }], plan: [], steps: [],
};

async function setup(controls = true) {
  const store = createMemoryStore();
  await store.upsertAction({ action_id: "a1", task_id: "t1", merchant: "airline", category: "flight", summary: "<img src=x onerror=alert(1)>", amount: 41200, ref: "R", source: "email", received_at: now, state: "verified" });
  await store.upsertChain(chain);
  await store.logEvent({ run_id: "r", arm: "proxy", scenario_id: "demo", layer: "scripted", kind: "email_in", tool_name: null, task_id: "t1", chain_id: null, action_id: null, outcome: "captured:jsonld", tokens_in: null, tokens_out: null, timestamp: now });
  const replies: HumanReply[] = [];
  const channel = createHumanChannel({ store, clock, humanNumber: "+15550000000", hooks: { onHumanReply: async (r) => void replies.push(r) }, sendText: async () => ({ message_id: "m" }) });
  const routes = createWebRoutes({ store, clock, channel, humanNumber: "+15550000000", controls });
  const call = (method: string, path: string, rawBody = "", headers: Record<string, string> = {}) =>
    routes.find((r) => r.method === method && r.path === path)!.handle({ method: method as "GET", path, headers, query: {}, rawBody });
  return { call, replies };
}

describe("web routes", () => {
  it("serves the page and never uses innerHTML", async () => {
    const { call } = await setup();
    const res = await call("GET", "/web");
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("<title>Proxy live</title>");
    expect(PAGE_HTML).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it("ships a page script that parses and has the three reply buttons", () => {
    const js = PAGE_HTML.match(/<script>([\s\S]*)<\/script>/)![1];
    expect(() => new Function(js)).not.toThrow();
    for (const label of ["UNDO ALL", "PICK", "KEEP", "Undo selected"]) expect(js).toContain(label);
  });

  it("reports chains, actions with Stripe verification, and events", async () => {
    const { call } = await setup();
    const body = (await call("GET", "/web/state")).body as any;
    expect(body.controls).toBe(true);
    expect(body.chains[0]).toMatchObject({ chain_id: "c1", state: "alerted", money_at_risk: 41200 });
    expect(body.chains[0].actions[0]).toMatchObject({ stripe_verified: true, state: "verified" });
    expect(body.events[0]).toMatchObject({ kind: "email_in", outcome: "captured:jsonld" });
  });

  it("buttons act like a text from the registered number, once", async () => {
    const { call, replies } = await setup();
    const post = () => call("POST", "/web/reply", JSON.stringify({ chain_id: "c1", kind: "undo_all" }));
    expect((await post()).status).toBe(200);
    await post();
    expect(replies).toMatchObject([{ kind: "undo_all", chain_id: "c1" }]);
  });

  it("a pick from the buttons reaches onHumanReply with the numbers", async () => {
    const { call, replies } = await setup();
    await call("POST", "/web/reply", JSON.stringify({ chain_id: "c1", kind: "pick", picks: [1] }));
    expect(replies).toMatchObject([{ kind: "pick", chain_id: "c1", picks: [1] }]);
  });

  it("is off when controls are off, and rejects bad input", async () => {
    const off = await setup(false);
    expect((await off.call("POST", "/web/reply", JSON.stringify({ chain_id: "c1", kind: "keep" }))).status).toBe(404);
    const on = await setup(true);
    expect((await on.call("POST", "/web/reply", "nope")).status).toBe(400);
    expect((await on.call("POST", "/web/reply", JSON.stringify({ chain_id: "c1", kind: "approve_everything" }))).status).toBe(400);
    expect((await on.call("POST", "/web/reply", JSON.stringify({ chain_id: "ghost", kind: "keep" }))).status).toBe(404);
  });
});
