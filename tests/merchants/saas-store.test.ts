import { describe, expect, it } from "vitest";
import { simulateBookings } from "../../evals/sim.js";
import { compare } from "../../src/logic/index.js";
import { createFakeDeps, createMerchants } from "../../src/merchants/index.js";
import type { BookingRequest } from "../../src/types.js";
import { demoIntent, extractJsonLd } from "../helpers/demo.js";

const TASK_EMAIL = "task_nyc@tasks.proxy.example";
const SENDER = "proxy-agent@inkboxmail.com";
const BOOKED = "2026-10-17T10:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const plus = (ms: number): string => new Date(Date.parse(BOOKED) + ms).toISOString();

function setup() {
  const fake = createFakeDeps();
  return { fake, merchants: createMerchants(fake.deps) };
}

const order = (merchant_id: "saas" | "store", item: string, amount: number): BookingRequest => ({
  merchant_id,
  task_id: "task_nyc",
  task_email: TASK_EMAIL,
  item,
  amount,
  booked_at: BOOKED,
});

const email = (ref: string) => ({ from: SENDER, subject: `Cancel ${ref}`, body: `Please cancel ${ref}. It was booked in error.` });

describe("SaaS vendor: booking and confirmation", () => {
  it("is a merchant with no agent, and with a support desk", () => {
    const { merchants } = setup();
    expect(merchants.get("saas")).toMatchObject({ category: "saas", has_agent: false, support_email: "billing@acmecloud.example" });
    expect(merchants.agent("saas")).toBeNull();
    expect(merchants.hasSupportDesk("saas")).toBe(true);
  });

  it("books with no dates, charges Stripe, and issues an SAS reference", async () => {
    const { fake, merchants } = setup();
    const result = await merchants.book(order("saas", "Acme Pro, billed annually", 24000));
    expect(result.ref).toMatch(/^SAS-[A-Z0-9]{6}$/);
    expect(fake.charges[0]).toMatchObject({ amount: 24000 });
    expect(fake.emails[0]).toMatchObject({ to: TASK_EMAIL, identity: "saas" });
  });

  it("sends schema.org Order markup with an ISO billing duration when the term is known", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(order("saas", "Acme Pro, billed annually", 24000));
    const monthly = await merchants.book(order("saas", "Acme Pro, monthly", 2000));

    expect(extractJsonLd(fake.emails[0].html)).toMatchObject({
      "@type": "Order",
      orderNumber: ref,
      seller: { name: "Acme Cloud" },
      acceptedOffer: {
        price: "240.00",
        priceCurrency: "USD",
        itemOffered: { "@type": "Service", name: "Acme Pro, billed annually" },
        priceSpecification: { billingDuration: "P1Y" },
      },
    });
    expect(extractJsonLd(fake.emails[1].html).acceptedOffer.priceSpecification.billingDuration).toBe("P1M");
    expect(monthly.ref).not.toBe(ref);
  });

  it("leaves the billing duration out when the plan name has no term", async () => {
    const { fake, merchants } = setup();
    await merchants.book(order("saas", "Acme Pro", 2000));
    expect(extractJsonLd(fake.emails[0].html).acceptedOffer.priceSpecification).toBeUndefined();
  });
});

describe("SaaS vendor: the support desk (14-day refund window)", () => {
  it("agrees the full refund inside the window, and does not touch Stripe", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(order("saas", "Acme Pro, billed annually", 24000));
    const reply = await merchants.supportEmail("saas", email(ref), plus(10 * DAY));
    expect(reply).toMatchObject({ approved: true, ref, refund_amount: 24000 });
    expect(reply.reply.body).toContain("REFUND APPROVED");
    expect(reply.reply.to).toBe(SENDER);
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refund_amount: 24000 });
    expect(Object.keys(fake.deps).sort()).toEqual(["charge", "deliver"]);
  });

  it("approves up to exactly 14 days and denies one millisecond later", async () => {
    const atLimit = setup();
    const a = await atLimit.merchants.book(order("saas", "Acme Pro", 24000));
    expect((await atLimit.merchants.supportEmail("saas", email(a.ref), plus(14 * DAY))).approved).toBe(true);

    const late = setup();
    const b = await late.merchants.book(order("saas", "Acme Pro", 24000));
    const denied = await late.merchants.supportEmail("saas", email(b.ref), plus(14 * DAY + 1));
    expect(denied).toMatchObject({ approved: false, refund_amount: 0 });
    expect(denied.reply.body).toContain("REFUND DENIED");
    expect(denied.reply.body).toContain("14-day");
    expect(late.merchants.getOrder(b.ref)?.status).toBe("confirmed");
  });

  it("is idempotent: a retry after the window still returns the agreed refund", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("saas", "Acme Pro", 24000));
    await merchants.supportEmail("saas", email(ref), plus(2 * DAY));
    const retry = await merchants.supportEmail("saas", email(ref), plus(30 * DAY));
    expect(retry).toMatchObject({ approved: true, refund_amount: 24000 });
    expect(retry.reply.body).toContain("already cancelled");
  });

  it("denies an unknown reference, asks for one when it is missing, and ignores other merchants' orders", async () => {
    const { merchants } = setup();
    expect(await merchants.supportEmail("saas", email("SAS-NOPE00"), BOOKED)).toMatchObject({ approved: false, ref: "SAS-NOPE00" });
    const none = await merchants.supportEmail("saas", { from: SENDER, subject: "Hi", body: "cancel please" }, BOOKED);
    expect(none).toMatchObject({ approved: false, ref: null });
    expect(none.reply.body).toContain("SAS-ABC123");
    const store = await merchants.book(order("store", "Rain jacket, size L", 20000));
    expect((await merchants.supportEmail("saas", email(store.ref), BOOKED)).approved).toBe(false);
  });

  it("has no self-serve cancel", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("saas", "Acme Pro", 24000));
    const result = await merchants.selfServeCancel("saas", ref, BOOKED);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("billing@acmecloud.example");
  });
});

describe("store: booking, confirmation and returns", () => {
  it("is a merchant with no agent, and with a returns desk", () => {
    const { merchants } = setup();
    expect(merchants.get("store")).toMatchObject({ category: "store", has_agent: false, support_email: "returns@northlineoutfitters.example" });
    expect(merchants.hasSupportDesk("store")).toBe(true);
  });

  it("sends schema.org Order markup naming the product, size and quantity", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(order("store", "USB-C hub x10", 34000));
    expect(ref).toMatch(/^STO-[A-Z0-9]{6}$/);
    expect(extractJsonLd(fake.emails[0].html)).toMatchObject({
      "@type": "Order",
      orderNumber: ref,
      acceptedOffer: { price: "340.00", itemOffered: { "@type": "Product", name: "USB-C hub x10" } },
    });
  });

  it("refunds in full for 30 days", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("store", "Rain jacket, size L", 20000));
    expect(await merchants.supportEmail("store", email(ref), plus(10 * DAY))).toMatchObject({ approved: true, refund_amount: 20000 });
  });

  it("takes a 15% restocking fee from day 30 to day 60, and says so", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("store", "Rain jacket, size L", 20000));
    const reply = await merchants.supportEmail("store", email(ref), plus(45 * DAY));
    expect(reply).toMatchObject({ approved: true, refund_amount: 17000 });
    expect(reply.reply.body).toContain("restocking fee of $30.00");
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refund_amount: 17000 });
  });

  it("changes at exactly day 30 and day 60", async () => {
    const days = async (ms: number) => {
      const { merchants } = setup();
      const { ref } = await merchants.book(order("store", "Rain jacket, size L", 20000));
      return merchants.supportEmail("store", email(ref), plus(ms));
    };
    expect((await days(30 * DAY)).refund_amount).toBe(20000);
    expect((await days(30 * DAY + 1)).refund_amount).toBe(17000);
    expect((await days(60 * DAY)).refund_amount).toBe(17000);
    expect(await days(60 * DAY + 1)).toMatchObject({ approved: false, refund_amount: 0 });
  });

  it("is idempotent: a retry returns the same fee-reduced refund", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("store", "Rain jacket, size L", 20000));
    await merchants.supportEmail("store", email(ref), plus(45 * DAY));
    const retry = await merchants.supportEmail("store", email(ref), plus(90 * DAY));
    expect(retry).toMatchObject({ approved: true, refund_amount: 17000 });
  });

  it("has no self-serve cancel", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(order("store", "Rain jacket, size L", 20000));
    expect((await merchants.selfServeCancel("store", ref, BOOKED)).ok).toBe(false);
  });
});

describe("SaaS and store: from confirmation email to compare", () => {
  it("an annual plan, read back from its email, is flagged against term:monthly", async () => {
    const world = await simulateBookings({
      task_id: "task_nyc",
      task_email: TASK_EMAIL,
      bookings: [{ id: "plan", merchant_id: "saas", item: "Acme Pro, billed annually", dates: { start: "2026-10-17" }, amount: 24000, booked_at: BOOKED }],
    });
    expect(world.actions[0]).toMatchObject({ category: "saas", summary: "Acme Pro, billed annually", amount: 24000, ref: expect.stringMatching(/^SAS-/) });
    expect(world.actions[0].dates).toBeUndefined();
    const intent = demoIntent({ constraints: { must_haves: ["term:monthly"] } });
    expect(compare(intent, world.actions)).toMatchObject([{ field: "term", expected: "monthly", actual: "annual" }]);
  });

  it("ten units, read back from the store's email, are flagged against quantity:1", async () => {
    const world = await simulateBookings({
      task_id: "task_nyc",
      task_email: TASK_EMAIL,
      bookings: [{ id: "hubs", merchant_id: "store", item: "USB-C hub x10", dates: { start: "2026-10-17" }, amount: 34000, booked_at: BOOKED }],
    });
    expect(world.actions[0]).toMatchObject({ category: "store", summary: "USB-C hub x10" });
    const intent = demoIntent({ constraints: { must_haves: ["quantity:1"] } });
    expect(compare(intent, world.actions)).toMatchObject([{ field: "item", expected: "quantity 1", actual: "quantity 10" }]);
  });
});
