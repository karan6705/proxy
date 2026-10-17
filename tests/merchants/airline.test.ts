import { describe, expect, it } from "vitest";
import { createFakeDeps, createMerchants, MerchantError } from "../../src/merchants/index.js";
import type { BookingRequest } from "../../src/types.js";
import { DEMO_NOW, FLIGHT_BOOKED_AT, extractJsonLd } from "../helpers/demo.js";

const TASK_EMAIL = "task-nyc@inbox.proxy.example";
const plus = (ts: string, ms: number): string => new Date(Date.parse(ts) + ms).toISOString();
const HOUR = 60 * 60 * 1000;

function setup() {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps);
  return { fake, merchants };
}

function flightRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    merchant_id: "airline",
    task_id: "task_nyc",
    task_email: TASK_EMAIL,
    item: "SFO-JFK",
    dates: { start: "2026-11-03" },
    amount: 41200,
    booked_at: FLIGHT_BOOKED_AT,
    ...overrides,
  };
}

describe("airline: booking", () => {
  it("is a merchant without an agent", () => {
    const { merchants } = setup();
    expect(merchants.get("airline")).toMatchObject({ merchant_id: "airline", category: "flight", has_agent: false });
    expect(merchants.agent("airline")).toBeNull();
  });

  it("charges Stripe for the full fare and returns the reference and charge id", async () => {
    const { fake, merchants } = setup();
    const result = await merchants.book(flightRequest());

    expect(result.ref).toMatch(/^AIR-[A-Z0-9]{6}$/);
    expect(result.amount).toBe(41200);
    expect(fake.charges).toHaveLength(1);
    expect(fake.charges[0]).toMatchObject({ charge_id: result.stripe_charge_id, amount: 41200 });
    expect(fake.charges[0].args).toMatchObject({ merchant: "airline", task_id: "task_nyc", ref: result.ref });
  });

  it("emails one confirmation to the task address, from the airline", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(flightRequest());

    expect(fake.emails).toHaveLength(1);
    const email = fake.emails[0];
    expect(email.to).toBe(TASK_EMAIL);
    expect(email.from.address).toContain("skylinedemoair");
    expect(email.subject).toContain(ref);
    expect(email.subject).toContain("SFO to JFK");
    expect(email.body).toContain(ref);
    expect(email.html).toContain(ref);
  });

  it("puts schema.org FlightReservation markup in the email", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(flightRequest());
    const jsonld = extractJsonLd(fake.emails[0].html);

    expect(jsonld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "FlightReservation",
      reservationNumber: ref,
      reservationStatus: "https://schema.org/ReservationConfirmed",
      totalPrice: "412.00",
      priceCurrency: "USD",
      underName: { email: TASK_EMAIL },
      reservationFor: {
        "@type": "Flight",
        departureAirport: { iataCode: "SFO" },
        arrivalAirport: { iataCode: "JFK" },
        departureTime: "2026-11-03T08:30:00-08:00",
        arrivalTime: "2026-11-03T17:05:00-05:00",
      },
    });
  });

  it("uses daylight-saving offsets for dates before the clocks change", async () => {
    const { fake, merchants } = setup();
    await merchants.book(flightRequest({ dates: { start: "2026-10-30" } }));
    const flight = extractJsonLd(fake.emails[0].html).reservationFor;
    expect(flight.departureTime).toBe("2026-10-30T08:30:00-07:00");
    expect(flight.arrivalTime).toBe("2026-10-30T17:05:00-04:00");
  });

  it("holds the confirmation back when it is deferred, then sends it once", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book({ ...flightRequest(), defer_confirmation: true });
    expect(fake.emails).toHaveLength(0);

    expect(await merchants.sendConfirmation("airline", ref)).toBe(true);
    expect(fake.emails).toHaveLength(1);
    expect(await merchants.sendConfirmation("airline", ref)).toBe(false);
    expect(fake.emails).toHaveLength(1);
  });

  it("gives two bookings of the same flight two different references and two charges", async () => {
    const { fake, merchants } = setup();
    const first = await merchants.book(flightRequest());
    const second = await merchants.book(flightRequest());
    expect(second.ref).not.toBe(first.ref);
    expect(fake.charges).toHaveLength(2);
  });

  it("produces the same reference for the same sequence of bookings", async () => {
    const a = await setup().merchants.book(flightRequest());
    const b = await setup().merchants.book(flightRequest());
    expect(a.ref).toBe(b.ref);
  });
});

describe("airline: bad input and failures", () => {
  it.each([
    ["a zero amount", { amount: 0 }],
    ["a fractional amount", { amount: 412.5 }],
    ["no dates", { dates: undefined }],
    ["a malformed date", { dates: { start: "Nov 3" } }],
    ["an email that is not an address", { task_email: "nobody" }],
    ["no task id", { task_id: "" }],
    ["the wrong merchant", { merchant_id: "hotel" }],
  ])("rejects %s without charging", async (_name, overrides) => {
    const { fake, merchants } = setup();
    await expect(merchants.book(flightRequest(overrides as Partial<BookingRequest>))).rejects.toMatchObject({
      name: "MerchantError",
      kind: "invalid_input",
    });
    expect(fake.charges).toHaveLength(0);
  });

  it("does not send a confirmation when the charge fails", async () => {
    const { fake, merchants } = setup();
    fake.failures.charge = true;
    await expect(merchants.book(flightRequest())).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(fake.emails).toHaveLength(0);
  });

  it("keeps the booking when the email cannot be delivered, and can resend it later", async () => {
    const { fake, merchants } = setup();
    fake.failures.deliver = true;
    await expect(merchants.book(flightRequest())).rejects.toBeInstanceOf(MerchantError);
    expect(fake.charges).toHaveLength(1);

    fake.failures.deliver = false;
    const ref = merchants.getOrder(fake.charges[0].args.ref)?.ref as string;
    expect(await merchants.sendConfirmation("airline", ref)).toBe(true);
    expect(fake.emails).toHaveLength(1);
  });
});

describe("airline: self-serve cancel (24-hour rule)", () => {
  it("refunds the full fare 3h 40m before the window closes", async () => {
    const { fake, merchants } = setup();
    const { ref, stripe_charge_id } = await merchants.book(flightRequest());

    const result = await merchants.selfServeCancel("airline", ref, DEMO_NOW);

    expect(result).toMatchObject({ ok: true, refund_amount: 41200 });
    expect(result.stripe_refund_id).toMatch(/^re_test_/);
    expect(fake.refunds).toEqual([
      expect.objectContaining({ charge_id: stripe_charge_id, amount: 41200, refund_id: result.stripe_refund_id }),
    ]);
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refunded_amount: 41200 });
  });

  it("allows the cancel at exactly 24 hours and refuses one millisecond later", async () => {
    const atLimit = setup();
    const a = await atLimit.merchants.book(flightRequest());
    expect((await atLimit.merchants.selfServeCancel("airline", a.ref, plus(FLIGHT_BOOKED_AT, 24 * HOUR))).ok).toBe(true);

    const late = setup();
    const b = await late.merchants.book(flightRequest());
    const refused = await late.merchants.selfServeCancel("airline", b.ref, plus(FLIGHT_BOOKED_AT, 24 * HOUR + 1));
    expect(refused).toMatchObject({ ok: false, refund_amount: 0, stripe_refund_id: null });
    expect(refused.reason).toContain("24-hour");
    expect(refused.reason).toContain("$75.00");
    expect(late.fake.refunds).toHaveLength(0);
  });

  it("does not apply when the flight departs less than 7 days after booking", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(flightRequest({ dates: { start: "2026-10-20" } }));
    const result = await merchants.selfServeCancel("airline", ref, plus(FLIGHT_BOOKED_AT, HOUR));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("7 days");
    expect(fake.refunds).toHaveLength(0);
  });

  it("applies at exactly 7 days out", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(flightRequest({ dates: { start: "2026-10-27" }, booked_at: "2026-10-20T00:00:00.000Z" }));
    expect((await merchants.selfServeCancel("airline", ref, "2026-10-20T01:00:00.000Z")).ok).toBe(true);
  });

  it("refuses to cancel the same booking twice and never refunds twice", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(flightRequest());
    await merchants.selfServeCancel("airline", ref, DEMO_NOW);
    const again = await merchants.selfServeCancel("airline", ref, DEMO_NOW);
    expect(again).toMatchObject({ ok: false, reason: "This booking is already cancelled." });
    expect(fake.refunds).toHaveLength(1);
  });

  it("refuses an unknown reference", async () => {
    const { merchants } = setup();
    expect(await merchants.selfServeCancel("airline", "AIR-NOPE00", DEMO_NOW)).toMatchObject({ ok: false, reason: "Unknown booking reference." });
  });

  it("reports a Stripe refund failure as an upstream error and keeps the booking", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(flightRequest());
    fake.failures.refund = true;
    await expect(merchants.selfServeCancel("airline", ref, DEMO_NOW)).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(merchants.getOrder(ref)?.status).toBe("confirmed");
  });
});
