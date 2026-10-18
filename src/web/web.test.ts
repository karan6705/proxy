import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/memory.js";
import { createHumanChannel } from "../inkbox/human.js";
import type { Chain, Clock, HumanReply } from "../types.js";
import { createWebRoutes } from "./index.js";
import { PAGE_HTML } from "./page.js";
import { STAGE_HTML } from "./stage.js";
import { FIXTURE_STEPS, fixtureFeed } from "./stage-feed.js";

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
  const call = (method: string, path: string, rawBody = "", headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
    routes.find((r) => r.method === method && r.path === path)!.handle({ method: method as "GET", path, headers, query, rawBody });
  return { call, replies, store };
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

describe("current run only", () => {
  it("shows the newest run's chains and hides earlier ones, unless asked", async () => {
    const { call, store } = await setup();
    await store.upsertChain({ ...chain, chain_id: "c_old", task_id: "t0", alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-10-01T09:00:00.000Z" }] });
    const state = (await call("GET", "/web/state")).body as any;
    expect(state.task_id).toBe("t1");
    expect(state.chains.map((c: any) => c.chain_id)).toEqual(["c1"]);
    expect(state.hidden_chains).toBe(1);
    expect(((await call("GET", "/web/state", "", {}, { all: "1" })).body as any).chains).toHaveLength(2);
    expect(((await call("GET", "/web/state", "", {}, { task_id: "t0" })).body as any).chains.map((c: any) => c.chain_id)).toEqual(["c_old"]);
  });

  it("uses the run the server says is current", async () => {
    const store = createMemoryStore();
    await store.upsertChain({ ...chain, chain_id: "c_a", task_id: "task_demo_1" });
    await store.upsertChain({ ...chain, chain_id: "c_b", task_id: "task_demo_2", alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-12-01T00:00:00.000Z" }] });
    const routes = createWebRoutes({ store, clock, currentTask: () => "task_demo_1" });
    const res = await routes.find((r) => r.path === "/web/state")!.handle({ method: "GET", path: "/web/state", headers: {}, query: {}, rawBody: "" });
    expect((res.body as any).chains.map((c: any) => c.chain_id)).toEqual(["c_a"]);
  });

  it("a button acts on its own chain even when another was alerted more recently", async () => {
    const { call, replies, store } = await setup();
    await store.upsertChain({ ...chain, chain_id: "c2", alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-11-01T09:55:00.000Z" }] });
    await call("POST", "/web/reply", JSON.stringify({ chain_id: "c1", kind: "keep" }));
    expect(replies).toMatchObject([{ kind: "keep", chain_id: "c1" }]);
  });
});

describe("stage page", () => {
  it("is served, dark and 16:9, and writes feed text only with textContent", async () => {
    const { call } = await setup();
    const res = await call("GET", "/web/stage");
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("<title>Proxy stage</title>");
    expect(STAGE_HTML).toContain("100vh*16/9");
    expect(STAGE_HTML).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|outerHTML/);
    for (const label of ["The mistake", "Proxy", "Agent to agent", "Recovered"]) expect(STAGE_HTML).toContain(label);
  });

  it("ships a script that parses", () => {
    const js = STAGE_HTML.match(/<script>([\s\S]*)<\/script>/)![1];
    expect(() => new Function(js)).not.toThrow();
  });

  it("serves a fixture that only ever adds to the story, and ends fully recovered", async () => {
    const { call } = await setup();
    let prev = fixtureFeed(0);
    for (let n = 1; n <= FIXTURE_STEPS.length; n += 1) {
      const f = fixtureFeed(n);
      expect(f.bookings.length).toBeGreaterThanOrEqual(prev.bookings.length);
      expect(f.human.length).toBeGreaterThanOrEqual(prev.human.length);
      expect((f.chain?.recovered ?? 0)).toBeGreaterThanOrEqual(prev.chain?.recovered ?? 0);
      expect(f.conversations.flatMap((c) => c.entries).length).toBeGreaterThanOrEqual(prev.conversations.flatMap((c) => c.entries).length);
      prev = f;
    }
    expect(prev.chain).toMatchObject({ total: 124000, recovered: 41200 + 54400 + 18800, state: "reversed" });
    expect(prev.chain!.rows.every((r) => r.verified || r.amount === 0)).toBe(true);
    expect(prev.human.map((h) => h.text).join(" ")).toContain("UNDO ALL");
    const texts = prev.conversations.flatMap((c) => c.entries.map((e) => e.text));
    expect(texts.some((t) => /store credit/i.test(t))).toBe(true);
    expect(texts.some((t) => /85%/.test(t))).toBe(true);
    expect(texts).toContain("Refund confirmed in Stripe · $544");
    const res = (await call("GET", "/web/stage-fixture", "", {}, { step: "7" })).body as any;
    expect(res.step).toBe(7);
    expect(res.chain.recovered).toBe(41200);
    expect((await call("GET", "/web/stage-fixture", "", {}, { step: "abc" })).status).toBe(400);
  });

  it("the fixture's wrong dates are the ones the page highlights", () => {
    const f = fixtureFeed(4);
    expect(f.task.intended_dates).toEqual({ start: "2026-11-13", end: "2026-11-16" });
    expect(f.bookings.every((b) => b.wrong && b.dates!.start === "2026-11-03")).toBe(true);
  });
});
