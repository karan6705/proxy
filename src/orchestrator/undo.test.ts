import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import type { Action, SimulatedClock } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";
import { createToolHandlers } from "../tools/handlers.js";

const START = "2026-10-25T10:00:00.000Z";
const slug = (ref: string) => ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let clock: SimulatedClock;
let rt: Runtime;
let inkbox: ReturnType<typeof createStandInInkbox>;
let tools: ReturnType<typeof createToolHandlers>;
let task_id: string;
let store: ReturnType<typeof createMemoryStore>;

async function booked(merchant_id: "airline" | "hotel" | "transfer" | "host", item: string, amount: number, category: Action["category"], dates: Action["dates"]) {
  const b = await rt.merchants.book({ merchant_id, task_id, task_email: `${task_id}@tasks.proxy.example`, item, dates, amount, booked_at: clock.now(), defer_confirmation: true });
  const action: Action = {
    action_id: `act_${task_id}_${slug(b.ref)}`,
    task_id,
    merchant: merchant_id,
    category,
    summary: item,
    amount,
    dates,
    ref: b.ref,
    source: merchant_id === "host" ? "agent" : "email",
    received_at: clock.now(),
    state: "found",
  };
  await rt.proxy.onAction(action);
  clock.advance(1000);
  return action;
}

beforeEach(async () => {
  clock = createSimulatedClock(START);
  inkbox = createStandInInkbox();
  store = createMemoryStore();
  rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
    env: { HUMAN_PHONE: "+14155550100", PROXY_ALERT_SETTLE_MS: "0" },
    store,
    inkbox,
  });
  tools = createToolHandlers(() => rt.proxy);
  const r = (await tools.log_intent({
    goal: "NYC trip for the Nov 13 conference, under $1,500",
    constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 150_000 },
    idempotency_key: "undo-test",
  })).structuredContent as { task_id: string };
  task_id = r.task_id;
});

const settle = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting");
};

describe("UNDO ALL after the agent has left", () => {
  it("undoes the whole chain, verifies every refund in Stripe, and hands back the redo", async () => {
    await booked("host", "Arrival email", 0, "message", { start: "2026-11-03" });
    rt.proxy.deps.sessions.end(task_id);
    clock.advance(5 * 60_000);
    const flight = await booked("airline", "Flight SFO to JFK, Nov 3", 41_200, "flight", { start: "2026-11-03" });
    const hotel = await booked("hotel", "Hotel, 3 nights", 64_000, "hotel", { start: "2026-11-03", end: "2026-11-06" });
    const transfer = await booked("transfer", "Airport transfer, Nov 3", 18_800, "transfer", { start: "2026-11-03" });
    await rt.proxy.alertChains(task_id);

    const [chain] = await rt.store.listChains(task_id);
    expect(chain?.alerts).toHaveLength(1);
    expect(chain?.state).toBe("alerted");
    expect(inkbox.outbox.find((o) => o.kind === "text")).toMatchObject({ kind: "text", channel: "imessage", to: "+14155550100" });

    const reply = await rt.human.handleInbound({ from: "+14155550100", body: "UNDO ALL", via: "imessage" });
    expect(reply).toMatchObject({ status: "forwarded", kind: "undo_all" });

    await settle(async () => (await rt.store.getChain(chain!.chain_id))?.state === "redo_requested");

    const state = async (id: string) => (await rt.store.getAction(id))?.state;
    expect(await state(flight.action_id)).toBe("verified");
    expect(await state(hotel.action_id)).toBe("verified");
    expect(await state(transfer.action_id)).toBe("verified");
    // The hotel agreed to 85% after the store-credit counter and one push back; Stripe shows exactly that.
    const charge = (await rt.proxy.deps.payments.findChargeForAction(hotel))!;
    expect(rt.fakePayments?.refundedOn(charge)).toBe(54_400);
    const steps = (await rt.store.getChain(chain!.chain_id))!.steps.filter((s) => s.action_id === hotel.action_id && s.protocol_state);
    expect(steps.map((s) => s.protocol_state)).toEqual(expect.arrayContaining(["requested", "pushed_back", "accepted", "refund_pending"]));
    expect(rt.fakePayments?.refunds.size).toBe(3);

    // The widget numbers and the redo instruction come back through get_chain.
    const view = await tools.get_chain({ chain_id: chain!.chain_id });
    expect(view.structuredContent).toMatchObject({ ok: true, next_action: "redo" });
    expect("_meta" in view && view._meta.recovered[hotel.action_id]).toBe(54_400);
    expect("_meta" in view && view._meta.recovered[flight.action_id]).toBe(41_200);
    const sent = store.events().map((e) => e.outcome).filter((o) => o?.startsWith("out:"));
    expect(sent).toEqual(["out:request_reversal", "out:push_back", "out:accept_counter"]);
  });

  it("the demo order: the agent self-undoes the flight, then UNDO ALL handles the rest of the chain", async () => {
    const flight = await booked("airline", "Flight SFO to JFK, Nov 3", 41_200, "flight", { start: "2026-11-03" });
    await booked("host", "Arrival email", 0, "message", { start: "2026-11-03" });
    await tools.review({ task_id });
    expect((await tools.undo({ action_ids: [flight.action_id], reason: "wrong date" })).structuredContent).toMatchObject({ accepted: [flight.action_id] });
    rt.proxy.deps.sessions.end(task_id);
    const hotel = await booked("hotel", "Hotel, 3 nights", 64_000, "hotel", { start: "2026-11-03", end: "2026-11-06" });
    await booked("transfer", "Airport transfer, Nov 3", 18_800, "transfer", { start: "2026-11-03" });
    await rt.proxy.alertChains(task_id);
    const [chain] = await rt.store.listChains(task_id);
    expect(chain).toMatchObject({ state: "alerted" });

    await rt.human.handleInbound({ from: "+14155550100", body: "UNDO ALL", via: "imessage" });
    await settle(async () => (await rt.store.getChain(chain!.chain_id))?.state === "redo_requested");

    const view = await tools.get_chain({ chain_id: chain!.chain_id });
    expect(view.structuredContent).toMatchObject({ ok: true, next_action: "redo" });
    expect("_meta" in view && view._meta.recovered).toMatchObject({ [flight.action_id]: 41_200, [hotel.action_id]: 54_400 });
    expect(rt.fakePayments?.refunds.size).toBe(3);
  });

  it("does nothing while STOP is in force", async () => {
    await booked("airline", "Flight SFO to JFK, Nov 3", 41_200, "flight", { start: "2026-11-03" });
    rt.proxy.deps.sessions.end(task_id);
    await rt.proxy.alertChains(task_id);
    const [chain] = await rt.store.listChains(task_id);
    await rt.proxy.onHumanReply({ kind: "stop", received_at: clock.now() });
    await rt.proxy.undo.start(chain!.chain_id);
    expect(rt.fakePayments?.refunds.size).toBe(0);
  });

  it("KEEP closes the chain without refunding", async () => {
    await booked("airline", "Flight SFO to JFK, Nov 3", 41_200, "flight", { start: "2026-11-03" });
    rt.proxy.deps.sessions.end(task_id);
    await rt.proxy.alertChains(task_id);
    const [chain] = await rt.store.listChains(task_id);
    await rt.proxy.onHumanReply({ kind: "keep", chain_id: chain!.chain_id, received_at: clock.now() });
    expect((await rt.store.getChain(chain!.chain_id))?.state).toBe("kept");
    expect(rt.fakePayments?.refunds.size).toBe(0);
  });
});
