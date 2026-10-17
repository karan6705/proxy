import { describe, expect, it } from "vitest";
import { createFakeDeps, createMerchants } from "../../src/merchants/index.js";
import type { BookingRequest } from "../../src/types.js";
import { DEMO_NOW, extractJsonLd } from "../helpers/demo.js";

const TASK_EMAIL = "task-nyc@inbox.proxy.example";
const SENDER = "proxy@tasks.proxy.example";

function transferRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    merchant_id: "transfer",
    task_id: "task_nyc",
    task_email: TASK_EMAIL,
    item: "Airport transfer, JFK to Harborview Hotel",
    dates: { start: "2026-11-03" },
    amount: 18800,
    booked_at: "2026-10-17T09:15:00.000Z",
    ...overrides,
  };
}

function setup() {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps);
  return { fake, merchants };
}

describe("transfer company: booking and confirmation", () => {
  it("has no agent, only a support desk", () => {
    const { merchants } = setup();
    expect(merchants.get("transfer")).toMatchObject({ has_agent: false, support_email: "support@metrotransfer.example" });
    expect(merchants.agent("transfer")).toBeNull();
    expect(merchants.hasSupportDesk("transfer")).toBe(true);
    expect(merchants.hasSupportDesk("airline")).toBe(false);
  });

  it("emails a TaxiReservation confirmation to the task address", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(transferRequest());

    expect(ref).toMatch(/^TRF-[A-Z0-9]{6}$/);
    expect(fake.charges[0]).toMatchObject({ amount: 18800 });
    expect(fake.emails).toHaveLength(1);
    expect(fake.emails[0].to).toBe(TASK_EMAIL);
    expect(fake.emails[0].body).toContain("Free cancellation until 24 hours before pickup");

    expect(extractJsonLd(fake.emails[0].html)).toMatchObject({
      "@type": "TaxiReservation",
      reservationNumber: ref,
      totalPrice: "188.00",
      priceCurrency: "USD",
      pickupTime: "2026-11-03T14:00:00-05:00",
      pickupLocation: { name: expect.stringContaining("JFK") },
      reservationFor: { provider: { name: "Metro Transfer Co.", email: "support@metrotransfer.example" } },
    });
  });

  it("has no self-serve cancel and points at support", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(transferRequest());
    const result = await merchants.selfServeCancel("transfer", ref, DEMO_NOW);
    expect(result).toMatchObject({ ok: false, refund_amount: 0 });
    expect(result.reason).toContain("support@metrotransfer.example");
  });
});

describe("transfer company: the support desk", () => {
  const email = (ref: string, overrides: Partial<{ from: string; subject: string; body: string }> = {}) => ({
    from: SENDER,
    subject: `Cancel booking ${ref}`,
    body: `Hello, please cancel booking ${ref}. The trip was booked for the wrong date.`,
    ...overrides,
  });

  it("approves a cancellation before the cutoff, refunds through Stripe and replies with REFUND APPROVED", async () => {
    const { fake, merchants } = setup();
    const { ref, stripe_charge_id } = await merchants.book(transferRequest());

    const reply = await merchants.supportEmail("transfer", email(ref), DEMO_NOW);

    expect(reply).toMatchObject({ approved: true, ref, refund_amount: 18800 });
    expect(reply.stripe_refund_id).toMatch(/^re_test_/);
    expect(fake.refunds).toEqual([expect.objectContaining({ charge_id: stripe_charge_id, amount: 18800 })]);
    expect(reply.reply.to).toBe(SENDER);
    expect(reply.reply.subject).toBe(`Re: Cancel booking ${ref}`);
    expect(reply.reply.body).toContain("REFUND APPROVED");
    expect(reply.reply.body).toContain("$188.00");
    expect(reply.reply.body).toContain(reply.stripe_refund_id as string);
    expect(reply.reply.html).toContain("REFUND APPROVED");
    expect(merchants.getOrder(ref)?.status).toBe("cancelled");
  });

  it("finds the reference in the subject when the body does not have it", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(transferRequest());
    const reply = await merchants.supportEmail("transfer", email(ref, { body: "Please cancel this one." }), DEMO_NOW);
    expect(reply.approved).toBe(true);
  });

  it("does not stack a second Re: on the subject", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(transferRequest());
    const reply = await merchants.supportEmail("transfer", email(ref, { subject: `Re: Cancel ${ref}` }), DEMO_NOW);
    expect(reply.reply.subject).toBe(`Re: Cancel ${ref}`);
  });

  it("approves right up to 24 hours before pickup and denies after", async () => {
    const onTime = setup();
    const a = await onTime.merchants.book(transferRequest());
    expect((await onTime.merchants.supportEmail("transfer", email(a.ref), "2026-11-02T00:00:00.000Z")).approved).toBe(true);

    const late = setup();
    const b = await late.merchants.book(transferRequest());
    const denied = await late.merchants.supportEmail("transfer", email(b.ref), "2026-11-02T00:00:00.001Z");
    expect(denied.approved).toBe(false);
    expect(denied.reply.body).toContain("REFUND DENIED");
    expect(late.fake.refunds).toHaveLength(0);
  });

  it("denies an unknown reference", async () => {
    const { fake, merchants } = setup();
    const reply = await merchants.supportEmail("transfer", email("TRF-NOPE00"), DEMO_NOW);
    expect(reply).toMatchObject({ approved: false, ref: "TRF-NOPE00" });
    expect(reply.reply.body).toContain("REFUND DENIED");
    expect(fake.refunds).toHaveLength(0);
  });

  it("asks for a booking reference when there is none", async () => {
    const { merchants } = setup();
    const reply = await merchants.supportEmail("transfer", { from: SENDER, subject: "Cancel please", body: "No reference here." }, DEMO_NOW);
    expect(reply).toMatchObject({ approved: false, ref: null });
    expect(reply.reply.body).toContain("TRF-ABC123");
  });

  it("does not refund a booking twice", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(transferRequest());
    await merchants.supportEmail("transfer", email(ref), DEMO_NOW);
    const second = await merchants.supportEmail("transfer", email(ref), DEMO_NOW);
    expect(second.approved).toBe(false);
    expect(second.reply.body).toContain("already been refunded");
    expect(fake.refunds).toHaveLength(1);
  });

  it("refuses support emails for merchants that have no support desk", async () => {
    const { merchants } = setup();
    await expect(merchants.supportEmail("airline", email("AIR-000000"), DEMO_NOW)).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("does not look up another merchant's bookings", async () => {
    const { merchants } = setup();
    const flight = await merchants.book({ ...transferRequest(), merchant_id: "airline", item: "SFO-JFK", amount: 41200 });
    const reply = await merchants.supportEmail("transfer", email(flight.ref), DEMO_NOW);
    expect(reply.approved).toBe(false);
  });
});
