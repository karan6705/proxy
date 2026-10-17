import { describe, expect, it } from "vitest";
import type { Action } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { createFakePayments, createRecordingStore, createStubMerchants, emptyChain } from "./fakes.js";
import { refundKey, refundOnce } from "./refunds.js";
import { runSelfServeRoute } from "./routes/self-serve.js";

const flight: Action = {
  action_id: "act_flight",
  task_id: "task_demo",
  merchant: "airline",
  category: "flight",
  summary: "Flight SFO to JFK, Nov 3",
  amount: 41_200,
  dates: { start: "2026-11-03" },
  ref: "AIR-1",
  source: "email",
  received_at: "2026-10-25T10:00:00.000Z",
  state: "planned",
};

describe("a refund happens at most once per action", () => {
  it("uses one idempotency key per action, whatever the route", () => {
    expect(refundKey("act_flight")).toBe("refund:act_flight");
  });

  it("does not refund again when Stripe already shows a refund, even if the idempotency key expired", async () => {
    // honorIdempotency: false means every refund() call would create a new refund, like an expired key.
    const fake = createFakePayments({ honorIdempotency: false });
    fake.addCharge("ch_1", "act_flight", 41_200);

    const first = await refundOnce(fake.payments, flight, 41_200); // e.g. the self-serve route
    const second = await refundOnce(fake.payments, flight, 41_200); // e.g. a later email-support route
    const third = await refundOnce(fake.payments, flight, 34_000); // e.g. a protocol counter for less

    expect(first).toMatchObject({ status: "refunded", verified: true });
    expect(second).toMatchObject({ status: "already_refunded", refund_id: null, verified: true });
    expect(third).toMatchObject({ status: "already_refunded", refund_id: null });
    expect(fake.refunds.size).toBe(1);
    expect(fake.refundedOn("ch_1")).toBe(41_200);
  });

  it("does not refund when there is no charge", async () => {
    const fake = createFakePayments();
    expect(await refundOnce(fake.payments, flight, 41_200)).toEqual({ status: "no_charge" });
    expect(fake.refunds.size).toBe(0);
  });

  it("does not trust a verified flag when Stripe's amount differs from the expected amount", async () => {
    let checks = 0;
    const result = await refundOnce(
      {
        async findChargeForAction() { return "ch_1"; },
        async refund() { return { refund_id: "re_1" }; },
        async verifyRefund() {
          checks += 1;
          return checks === 1
            ? { verified: false, refunded_amount: 0 }
            : { verified: true, refunded_amount: 34_000 };
        },
      },
      flight,
      41_200,
    );

    expect(result).toMatchObject({ status: "refunded", verified: false, refunded_amount: 34_000 });
  });
});

describe("an action is verified only after verifyRefund returns true", () => {
  async function setup() {
    const clock = createSimulatedClock("2026-10-25T10:00:00.000Z");
    const merchants = createStubMerchants();
    const fake = createFakePayments({ settleRefunds: false, honorIdempotency: false });
    const mem = createRecordingStore();
    const booking = await merchants.book({
      merchant_id: "airline",
      task_id: "task_demo",
      task_email: "task_demo@tasks.proxy.example",
      item: "Flight",
      dates: { start: "2026-11-03" },
      amount: 41_200,
      booked_at: clock.now(),
    });
    fake.addCharge(booking.stripe_charge_id, "act_flight", 41_200);
    const action = { ...flight, ref: booking.ref };
    const deps = { merchants, payments: fake.payments, store: mem.store, clock };
    return { deps, action, fake, mem, chain: emptyChain("chain_demo", "task_demo", action, null) };
  }

  it("stays refund_pending while Stripe has not settled the refund", async () => {
    const { deps, action, chain, mem } = await setup();
    const r = await runSelfServeRoute(deps, chain, action);
    expect(r.action.state).toBe("refund_pending");
    expect(mem.actions.get("act_flight")?.state).toBe("refund_pending");
  });

  it("becomes verified once Stripe shows the money, without a second refund", async () => {
    const { deps, action, chain, fake } = await setup();
    await runSelfServeRoute(deps, chain, action);
    fake.settleAll();

    const again = await runSelfServeRoute(deps, chain, action);

    expect(again.action.state).toBe("verified");
    expect(fake.refunds.size).toBe(1);
    expect(fake.refundedOn("ch_stub_1")).toBe(41_200);
  });
});
