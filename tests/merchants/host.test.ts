import { describe, expect, it } from "vitest";
import { createFakeDeps, createMerchants } from "../../src/merchants/index.js";
import type { BookingRequest } from "../../src/types.js";
import { DEMO_NOW, extractJsonLd } from "../helpers/demo.js";

const TASK_EMAIL = "task_nyc@tasks.proxy.example";
const SENDER = "proxy@tasks.proxy.example";

function arrivalEmail(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    merchant_id: "host",
    task_id: "task_nyc",
    task_email: TASK_EMAIL,
    item: "Arrival email to the host: arriving 2026-11-03",
    dates: { start: "2026-11-03" },
    amount: 0,
    booked_at: "2026-10-17T09:30:00.000Z",
    ...overrides,
  };
}

function setup() {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps);
  return { fake, merchants };
}

const correction = (ref: string, body = `Please correct message ${ref}: the arrival date is 2026-11-13, not 2026-11-03.`) => ({
  from: SENDER,
  subject: `Correction to ${ref}`,
  body,
});

describe("host: the agent's arrival email", () => {
  it("is a person with no agent, who takes corrections by email", () => {
    const { merchants } = setup();
    expect(merchants.get("host")).toMatchObject({ merchant_id: "host", category: "message", has_agent: false });
    expect(merchants.agent("host")).toBeNull();
    expect(merchants.hasSupportDesk("host")).toBe(true);
  });

  it("records the message for $0 without charging Stripe", async () => {
    const { fake, merchants } = setup();
    const result = await merchants.book(arrivalEmail());
    expect(result).toMatchObject({ amount: 0, stripe_charge_id: "no_charge" });
    expect(result.ref).toMatch(/^MSG-[A-Z0-9]{6}$/);
    expect(fake.charges).toHaveLength(0);
  });

  it("sends a copy to the task address with schema.org EmailMessage markup", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());

    expect(fake.emails).toHaveLength(1);
    expect(fake.emails[0].to).toBe(TASK_EMAIL);
    expect(fake.emails[0].subject).toContain(ref);
    expect(fake.emails[0].body).toContain("arriving 2026-11-03");

    expect(extractJsonLd(fake.emails[0].html)).toMatchObject({
      "@context": "https://schema.org",
      "@type": "EmailMessage",
      identifier: ref,
      subject: "Arrival email to the host: arriving 2026-11-03",
      sender: { email: TASK_EMAIL },
      toRecipient: { name: "Alex Rivera (host)", email: "alex.rivera@example.com" },
      about: { startDate: "2026-11-03" },
    });
  });

  it("still requires a positive amount from every other merchant", async () => {
    const { merchants } = setup();
    await expect(merchants.book({ ...arrivalEmail(), merchant_id: "transfer", item: "Transfer", amount: 0 })).rejects.toMatchObject({
      kind: "invalid_input",
    });
  });

  it("rejects a negative or fractional amount", async () => {
    const { merchants } = setup();
    await expect(merchants.book(arrivalEmail({ amount: -1 }))).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(merchants.book(arrivalEmail({ amount: 0.5 }))).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("can hold the copy back and send it later, once", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book({ ...arrivalEmail(), defer_confirmation: true });
    expect(fake.emails).toHaveLength(0);
    expect(await merchants.sendConfirmation("host", ref)).toBe(true);
    expect(await merchants.sendConfirmation("host", ref)).toBe(false);
    expect(fake.emails).toHaveLength(1);
  });

  it("cannot be cancelled: a sent message cannot be unsent", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());
    const result = await merchants.selfServeCancel("host", ref, DEMO_NOW);
    expect(result).toMatchObject({ ok: false, refund_amount: 0, stripe_refund_id: null });
    expect(result.reason).toContain("correction");
    expect(merchants.getOrder(ref)?.status).toBe("confirmed");
  });
});

describe("host: the correction", () => {
  it("acknowledges a correction, names the new date, and marks the message corrected", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());

    const reply = await merchants.supportEmail("host", correction(ref), DEMO_NOW);

    expect(reply).toMatchObject({ approved: true, ref, refund_amount: 0 });
    expect(reply.reply.to).toBe(SENDER);
    expect(reply.reply.subject).toBe(`Re: Correction to ${ref}`);
    expect(reply.reply.body).toContain("updated my plans");
    expect(reply.reply.body).toContain("Nov 13, 2026");
    expect(reply.reply.html).toContain("updated my plans");
    expect(merchants.getOrder(ref)?.status).toBe("corrected");
  });

  it("moves no money: nothing is charged, and no refund is agreed", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());
    await merchants.supportEmail("host", correction(ref), DEMO_NOW);
    expect(fake.charges).toHaveLength(0);
    expect(merchants.getOrder(ref)?.refund_amount).toBe(0);
  });

  it("works without a new date in the correction", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());
    const reply = await merchants.supportEmail("host", correction(ref, `Sorry, ${ref} had the wrong date.`), DEMO_NOW);
    expect(reply.approved).toBe(true);
    expect(reply.reply.body).toContain("I have updated my plans.");
  });

  it("is idempotent: a repeated correction is acknowledged again and changes nothing", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());
    const first = await merchants.supportEmail("host", correction(ref), DEMO_NOW);
    const second = await merchants.supportEmail("host", correction(ref), DEMO_NOW);
    expect(second).toEqual(first);
    expect(merchants.getOrder(ref)?.status).toBe("corrected");
  });

  it("finds the reference in the subject when the body does not have it", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(arrivalEmail());
    const reply = await merchants.supportEmail("host", correction(ref, "Sorry, wrong date."), DEMO_NOW);
    expect(reply.approved).toBe(true);
  });

  it("asks which message when there is no reference", async () => {
    const { merchants } = setup();
    const reply = await merchants.supportEmail("host", { from: SENDER, subject: "Oops", body: "Wrong date." }, DEMO_NOW);
    expect(reply).toMatchObject({ approved: false, ref: null });
    expect(reply.reply.body).toContain("MSG-ABC123");
  });

  it("does not know a message it never received", async () => {
    const { merchants } = setup();
    const reply = await merchants.supportEmail("host", correction("MSG-NOPE00"), DEMO_NOW);
    expect(reply).toMatchObject({ approved: false, ref: "MSG-NOPE00" });
  });

  it("does not accept a correction for another merchant's booking", async () => {
    const { merchants } = setup();
    const flight = await merchants.book({ ...arrivalEmail(), merchant_id: "airline", item: "SFO-JFK", amount: 41200 });
    const reply = await merchants.supportEmail("host", correction(flight.ref), DEMO_NOW);
    expect(reply.approved).toBe(false);
  });
});
