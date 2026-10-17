import { describe, expect, it } from "vitest";
import type { Action } from "../../types.js";
import { createSimulatedClock } from "../clock.js";
import { createFakePayments, createMemoryStore, createStubMerchants, emptyChain } from "../fakes.js";
import { runSelfServeRoute } from "./self-serve.js";

// The demo mistake: a Nov 3 flight instead of Nov 13. The 24-hour rule needs departure at least
// 7 days after booking, so the seeded booking time is Oct 25.
const BOOKED_AT = "2026-10-25T10:00:00.000Z";

async function setup(opts: { settleRefunds?: boolean } = {}) {
  const clock = createSimulatedClock(BOOKED_AT);
  const merchants = createStubMerchants();
  const fake = createFakePayments(opts);
  const mem = createMemoryStore();

  const booking = await merchants.book({
    merchant_id: "airline",
    task_id: "task_demo",
    task_email: "task_demo@tasks.proxy.example",
    item: "Flight SFO to JFK",
    dates: { start: "2026-11-03" },
    amount: 41200,
    booked_at: clock.now(),
  });
  fake.addCharge(booking.stripe_charge_id, "act_flight", booking.amount);

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

  it("never refunds twice when retried", async () => {
    const { deps, chain, action, fake } = await setup();

    await runSelfServeRoute(deps, chain, action);
    const again = await runSelfServeRoute(deps, chain, action);

    expect(again.action.state).toBe("verified");
    expect(fake.refunds.size).toBe(1);
  });
});
