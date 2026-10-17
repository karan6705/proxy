import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../db/index.js";
import { logic } from "../../logic/index.js";
import { createMerchants } from "../../merchants/index.js";
import { createToolHandlers } from "../../tools/handlers.js";
import type { Action } from "../../types.js";
import { createSimulatedClock } from "../clock.js";
import { createFakePayments, createRecordingStore, emptyChain } from "../fakes.js";
import type { Proxy } from "../proxy.js";
import { runSelfServeRoute } from "./self-serve.js";

// The demo mistake: a Nov 3 flight instead of Nov 13. The 24-hour rule needs departure at least
// 7 days after booking, so the seeded booking time is Oct 25.
const BOOKED_AT = "2026-10-25T10:00:00.000Z";

async function setup(opts: { settleRefunds?: boolean } = {}) {
  const clock = createSimulatedClock(BOOKED_AT);
  const fake = createFakePayments(opts);
  const mem = createRecordingStore();
  let chargeSequence = 0;
  const merchants = createMerchants({
    async charge(args) {
      const charge_id = `ch_airline_${++chargeSequence}`;
      fake.addCharge(charge_id, "act_flight", args.amount);
      return { charge_id };
    },
    async deliver() {},
  });

  const booking = await merchants.book({
    merchant_id: "airline",
    task_id: "task_demo",
    task_email: "task_demo@tasks.proxy.example",
    item: "Flight SFO to JFK",
    dates: { start: "2026-11-03" },
    amount: 41200,
    booked_at: clock.now(),
  });
  const action: Action = {
    action_id: "act_flight",
    task_id: "task_demo",
    merchant: "airline",
    category: "flight",
    summary: "Flight SFO to JFK, Nov 3",
    amount: 41200,
    dates: { start: "2026-11-03" },
    ref: booking.ref,
    source: "email",
    received_at: clock.now(),
    state: "planned",
  };
  const chain = emptyChain("chain_demo", "task_demo", action, null);
  const deps = { merchants, payments: fake.payments, store: mem.store, clock };
  return { clock, deps, chain, action, fake, mem };
}

describe("self-serve route (airline 24-hour rule)", () => {
  it("cancels, refunds and verifies within 24 hours", async () => {
    const { clock, deps, chain, action, fake, mem } = await setup();
    clock.advance(3 * 3_600_000);

    const result = await runSelfServeRoute(deps, chain, action);

    expect(result.action.state).toBe("verified");
    expect(result.step).toMatchObject({ route: "self_serve", outcome: "succeeded", stripe_ref: "re_fake_1" });
    expect(result.step.at).toBe("2026-10-25T13:00:00.000Z");
    expect(fake.refunds.get("refund:act_flight")?.amount).toBe(41200);
    expect(mem.actions.get("act_flight")?.state).toBe("verified");
    expect(mem.steps).toHaveLength(1);
  });

  it("runs the real airline through cancel, refund and verification so the widget row is green", async () => {
    const { deps, chain, action, fake } = await setup();
    const store = createMemoryStore();
    await store.putIntent(
      {
        task_id: action.task_id,
        task_email: "task-demo@inkboxmail.com",
        goal: "NYC trip for the Nov 13 conference, under $1,500",
        constraints: { dates: { start: "2026-11-13", end: "2026-11-16" } },
        preferences: { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false },
        created_at: BOOKED_AT,
      },
      "widget-green",
    );
    await store.upsertAction(action);
    await store.upsertChain(chain);

    const route = await runSelfServeRoute({ ...deps, store }, chain, action);
    expect(route.action.state).toBe("verified");

    const handlers = createToolHandlers(() => ({
      deps: { store, logic, clock: deps.clock, payments: fake.payments },
    }) as unknown as Proxy);
    const result = await handlers.get_chain({ chain_id: chain.chain_id });
    if (!result.structuredContent.ok) throw new Error(result.structuredContent.message);
    expect(result.structuredContent.actions).toEqual([
      expect.objectContaining({ action_id: action.action_id, state: "verified", stripe_verified: true }),
    ]);
  });

  it("fails without refunding after the 24-hour window", async () => {
    const { clock, deps, chain, action, fake } = await setup();
    clock.advance(25 * 3_600_000);

    const result = await runSelfServeRoute(deps, chain, action);

    expect(result.action.state).toBe("failed");
    expect(result.step.outcome).toBe("failed");
    expect(result.step.message).toContain("24-hour");
    expect(fake.refunds.size).toBe(0);
  });

  it("stays refund_pending until Stripe shows the money", async () => {
    const { deps, chain, action } = await setup({ settleRefunds: false });

    const result = await runSelfServeRoute(deps, chain, action);

    expect(result.action.state).toBe("refund_pending");
    expect(result.step.outcome).toBe("pending");
  });

  it.each([
    ["zero", 0],
    ["missing", undefined],
  ])("never verifies a %s merchant refund amount", async (_label, refundAmount) => {
    const { deps, chain, action, fake } = await setup();
    const result = await runSelfServeRoute(
      {
        ...deps,
        merchants: {
          async selfServeCancel() {
            return { ok: true as const, refund_amount: refundAmount as number, stripe_refund_id: null };
          },
        },
      },
      chain,
      action,
    );

    expect(result.action.state).toBe("refund_pending");
    expect(result.step.outcome).toBe("pending");
    expect(fake.refunds.size).toBe(0);
  });

  it("never verifies a partial refund when the action expects a full refund", async () => {
    const { deps, chain, action, fake } = await setup();
    const result = await runSelfServeRoute(
      {
        ...deps,
        merchants: {
          async selfServeCancel() {
            return { ok: true as const, refund_amount: 34_000, stripe_refund_id: null };
          },
        },
      },
      chain,
      action,
    );

    expect(result.action.state).toBe("refund_pending");
    expect(result.step.message).toContain("expected the full 41200 refund");
    expect(fake.refunds.size).toBe(0);
  });

  it("never refunds twice when retried", async () => {
    const { deps, chain, action, fake } = await setup();

    await runSelfServeRoute(deps, chain, action);
    const again = await runSelfServeRoute(deps, chain, action);

    expect(again.action.state).toBe("verified");
    expect(fake.refunds.size).toBe(1);
  });
});
