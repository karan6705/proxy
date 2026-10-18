import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createSimulatedClock } from "../orchestrator/clock.js";
import { DEFAULT_PARAMS } from "../orchestrator/params.js";
import { createRuntime, DEMO_HUMAN_NUMBER } from "../orchestrator/runtime.js";
import { createStandInInkbox } from "../orchestrator/standin-inkbox.js";
import { createToolHandlers } from "../tools/handlers.js";
import { createHttpMerchants } from "./http-merchants.js";
import type { ToolClient } from "./mcp-client.js";
import { runAmbiguousAgent, runPlanAgent } from "./scenarios.js";
import { DEMO_START } from "./scripted.js";

/** A demo server in process: the agent's MCP calls go to the tool handlers, its HTTP calls to the runtime's routes. */
async function demoServer() {
  const clock = createSimulatedClock(DEMO_START);
  const inkbox = createStandInInkbox();
  const rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
    store: createMemoryStore(),
    inkbox,
    env: { PROXY_DEMO_ROUTES: "1", PROXY_SIMULATED_PAYMENTS: "1", PROXY_ALERT_SETTLE_MS: "0", PROXY_DEMO_REDO_GAP_MS: "0" },
  });
  const task_id = await rt.proxy.startDemoTask();
  const tools = createToolHandlers(() => rt.proxy) as unknown as Record<string, (a: unknown) => Promise<{ structuredContent: unknown }>>;
  const client: ToolClient = { callTool: async <T,>(name: string, args: Record<string, unknown>) => (await tools[name]!(args)).structuredContent as T, close: async () => {} };
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    const route = rt.routes.find((r) => r.method === "POST" && r.path === url.pathname);
    if (!route) return new Response("no route", { status: 404 });
    const res = await route.handle({ method: "POST", path: url.pathname, headers: {}, query: {}, rawBody: String(init?.body ?? "") });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  const merchants = createHttpMerchants("http://demo.test/mcp", fetchImpl, (id) => id === "hotel" || id === "saas");
  const control = {
    endSession: async (id: string) => {
      rt.proxy.deps.sessions.end(id);
      clock.set("2026-11-01T20:19:15.000Z");
    },
  };
  const texts = () => rt.proxy.feed.list(task_id).filter((e) => e.kind === "text_out").map((e) => e.text);
  const until = async (done: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 300 && !(await done()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { rt, clock, client, merchants, control, task_id, texts, until, reply: (body: string) => rt.human.handleInbound({ from: DEMO_HUMAN_NUMBER, body, via: "sms" }) };
}

describe("demo:go --scenario ambiguous", () => {
  it("asks the human before anything is booked, then books the dates they meant", async () => {
    const s = await demoServer();
    const run = runAmbiguousAgent({ client: s.client, merchants: s.merchants, control: s.control, now: s.clock.now, write: () => {}, pollMs: 5 });
    await s.until(() => s.texts().length > 0);
    expect(s.texts()).toEqual(["You wrote 3/11. Your agent read it as Mar 11. Did you mean Nov 3 or Mar 11? Reply 1 or 2."]);
    expect(await s.rt.store.listActions(s.task_id)).toEqual([]);
    await s.reply("1");
    const r = await run;
    expect(r.booked_dates).toEqual({ start: "2026-11-03", end: "2026-11-06" });
    expect(r.review.status).toBe("clean");
    expect(await s.rt.store.listChains(s.task_id)).toEqual([]);
    expect((await s.rt.store.listActions(s.task_id)).map((a) => a.dates?.start).sort()).toEqual(["2026-11-03", "2026-11-03", "2026-11-03"]);
  });
});

describe("demo:go --scenario plan", () => {
  it("annual instead of monthly: flagged after the agent leaves, refunded after UNDO ALL, re-subscribed monthly", async () => {
    const s = await demoServer();
    const r = await runPlanAgent({ client: s.client, merchants: s.merchants, control: s.control, now: s.clock.now, write: () => {} });
    expect(r.review.status).toBe("clean"); // the receipt hadn't arrived when the agent checked
    await s.until(() => s.texts().length > 0);
    expect(s.texts()[0]).toMatch(/^Your agent signed up for the annual plan, not monthly\./);
    const [chain] = await s.rt.store.listChains(s.task_id);
    await s.reply("UNDO ALL");
    await s.until(async () => (await s.rt.store.getChain(chain!.chain_id))?.state === "redone");
    expect((await s.rt.store.getChain(chain!.chain_id))?.state).toBe("redone");
    const refunds = s.rt.proxy.feed.list(s.task_id).filter((e) => e.kind === "stripe_refund");
    expect(refunds.map((e) => e.data.amount)).toEqual([118_800]);
    expect(s.texts().at(-1)).toBe("Re-subscribed: Acme Cloud Team plan, billed monthly, $99. It matches what you asked for.");
  });
});
