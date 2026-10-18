import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import { createSimulatedClock } from "./clock.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createRuntime, routesFor, startProtocolInbox } from "./runtime.js";

// Keys that look real. In cloud mode none of them may have any effect.
const KEYS = { INKBOX_API_KEY: "ApiKey_not_real_0000", STRIPE_SECRET_KEY: "sk_test_not_real_0000", ANTHROPIC_API_KEY: "sk-ant-not-real", SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "not-real", HUMAN_PHONE: "+15555550198" };
const clock = () => createSimulatedClock("2026-10-25T14:00:00.000Z");

describe("PROXY_MODE=cloud", () => {
  it("uses simulated payments, a stand-in Inkbox and no phone, even with keys present", async () => {
    const rt = createRuntime(clock(), DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { ...KEYS, PROXY_MODE: "cloud" } });
    expect(rt.fakePayments).not.toBeNull();
    expect(rt.proxy.deps.paymentsName).toBe("Stripe (simulated)");
    expect(rt.proxy.deps.canTextHuman).toBe(false);
    expect(rt.proxy.deps.humanNumber).not.toBe(KEYS.HUMAN_PHONE);
    // Nothing is texted: the alert is recorded on the chain only.
    const tools = createToolHandlers(() => rt.proxy);
    await tools.log_intent({ goal: "x", constraints: { dates: { start: "2026-11-13" } }, idempotency_key: "k" });
    expect(JSON.stringify(await rt.store.listChains())).not.toContain("5555550198");
  });

  it("never starts the Inkbox poller, even with a key and loopback off", async () => {
    const started = await startProtocolInbox(() => { throw new Error("must not be called"); }, clock(), { ...KEYS, PROXY_MODE: "cloud", PROXY_PROTOCOL_LOOPBACK: "0" });
    expect(started).toBeNull();
  });

  it("does not mount the webhooks, the mock merchants' endpoints or the reply button", () => {
    const routes = createRuntime(clock(), DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { ...KEYS, PROXY_MODE: "cloud", PROXY_DEMO_ROUTES: "1" }, store: createMemoryStore() }).routes;
    const all = routes.map((r) => `${r.method} ${r.path}`);
    expect(all.some((r) => r.includes("/inkbox/"))).toBe(true); // they exist in the runtime...
    const mounted = routesFor(routes, true).map((r) => `${r.method} ${r.path}`);
    expect(mounted.filter((r) => r.includes("/inkbox/") || r.includes("/merchants") || r.includes("/web/reply"))).toEqual([]); // ...but are not mounted
    expect(mounted).toContain("GET /web/stage");
    expect(routesFor(routes, false)).toEqual(routes);
  });
});

describe("plain text for every tool", () => {
  it("answers in plain English first, with the JSON after", async () => {
    const rt = createRuntime(clock(), DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: {}, store: createMemoryStore() });
    const tools = createToolHandlers(() => rt.proxy);
    const logged = await tools.log_intent({ goal: "NYC trip", constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 150_000 }, idempotency_key: "text" });
    expect(logged.content[0]?.text).toMatch(/^Task logged\. task_id: task_\w+\. task_email: .+\.\nNext: use task_email/);
    expect(JSON.parse(logged.content[1]!.text)).toMatchObject({ ok: true });
    if (!logged.structuredContent.ok) throw new Error("log_intent failed");

    const rev = await tools.reversibility({ merchant: "airline", category: "flight", amount: 41_200, dates: { start: "2026-11-03" } });
    expect(rev.content[0]?.text).toMatch(/^This action can be cancelled for a refund\./);
    expect(rev.content[0]?.text).toContain("Next:");

    const review = await tools.review({ task_id: logged.structuredContent.task_id });
    expect(review.content[0]?.text).toMatch(/^Review: clean\./);
    expect(review.content[0]?.text).toContain("Next: you can tell the human you are done.");

    const none = await tools.list_chains({});
    expect(none.content[0]?.text).toMatch(/^No open chains\. Next:/);

    const undone = await tools.undo({ action_ids: ["nope"], reason: "test" });
    expect(undone.content[0]?.text).toMatch(/^Nothing was undone by you\./);

    const err = await tools.get_chain({ chain_id: "chain_nope" });
    expect(err.content[0]?.text).toMatch(/^Error \(not_found\): No chain chain_nope\. .+Don't retry the same call\. Next: fix now\.$/);
    expect(JSON.parse(err.content[1]!.text)).toMatchObject({ ok: false, code: "not_found" });
  });
});
