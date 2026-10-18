import { describe, expect, it } from "vitest";
import { createFakeDeps, createMerchants, type HotelAgentOptions } from "../../src/merchants/index.js";
import type {
  AcceptCounterMsg,
  AskHumanMsg,
  BookingRequest,
  MerchantProtocolMessage,
  ProtocolEnvelope,
  PushBackMsg,
} from "../../src/types.js";
import { DEMO_NOW, extractJsonLd, requestReversal } from "../helpers/demo.js";

const TASK_EMAIL = "task_nyc@tasks.proxy.example";

function hotelRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    merchant_id: "hotel",
    task_id: "task_nyc",
    task_email: TASK_EMAIL,
    item: "Harborview Hotel, 3 nights",
    dates: { start: "2026-11-03", end: "2026-11-06" },
    amount: 64000,
    booked_at: "2026-10-17T11:00:00.000Z",
    ...overrides,
  };
}

function setup(options: HotelAgentOptions = {}) {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps, { hotel: options });
  const agent = merchants.agent("hotel");
  if (!agent) {
    throw new Error("the hotel should have an agent");
  }
  return { fake, merchants, agent };
}

function envelope(round: number): ProtocolEnvelope {
  return { negotiation_id: "neg_1", chain_id: "chain_act_flight", action_id: "act_hotel", round, sent_at: DEMO_NOW };
}
const pushBack = (round: number): PushBackMsg => ({ ...envelope(round), type: "push_back", reason: "The human's preferences do not allow store credit." });
const acceptCounter = (round: number): AcceptCounterMsg => ({ ...envelope(round), type: "accept_counter" });
const askHuman = (round: number): AskHumanMsg => ({ ...envelope(round), type: "ask_human", counter: { kind: "store_credit", amount: 64000 } });

describe("hotel: booking and confirmation", () => {
  it("is a merchant with an agent", () => {
    const { merchants } = setup();
    expect(merchants.get("hotel")).toMatchObject({ has_agent: true, agent_identity: "hotel-agent" });
  });

  it("emails a LodgingReservation confirmation to the task address", async () => {
    const { fake, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());

    expect(ref).toMatch(/^HTL-[A-Z0-9]{6}$/);
    expect(fake.charges[0]).toMatchObject({ amount: 64000 });
    expect(fake.emails).toHaveLength(1);
    expect(fake.emails[0].to).toBe(TASK_EMAIL);
    expect(fake.emails[0].body).toContain("3 nights");
    expect(fake.emails[0].body).toContain("non-refundable");

    expect(extractJsonLd(fake.emails[0].html)).toMatchObject({
      "@type": "LodgingReservation",
      reservationNumber: ref,
      totalPrice: "640.00",
      priceCurrency: "USD",
      checkinTime: "2026-11-03T15:00:00-05:00",
      checkoutTime: "2026-11-06T11:00:00-05:00",
      reservationFor: { "@type": "LodgingBusiness", name: "Harborview Hotel", address: { addressLocality: "New York" } },
    });
  });

  it("needs a check-out date after check-in", async () => {
    const { fake, merchants } = setup();
    await expect(merchants.book(hotelRequest({ dates: { start: "2026-11-03" } }))).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(merchants.book(hotelRequest({ dates: { start: "2026-11-03", end: "2026-11-03" } }))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(fake.charges).toHaveLength(0);
  });

  it("has no self-serve cancel: the rate is non-refundable", async () => {
    const { merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    const result = await merchants.selfServeCancel("hotel", ref, DEMO_NOW);
    expect(result).toMatchObject({ ok: false, refund_amount: 0 });
    expect(result.reason).toContain("goodwill");
  });
});

describe("hotel agent: the demo negotiation (store credit, push back, 85%)", () => {
  it("counters with full-price store credit in round 1", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());

    const reply = await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);

    expect(reply).toMatchObject({
      type: "counter",
      kind: "store_credit",
      amount: 64000,
      negotiation_id: "neg_1",
      chain_id: "chain_act_flight",
      action_id: "act_hotel",
      round: 1,
      sent_at: DEMO_NOW,
    });
  });

  it("counters with an 85% partial refund after the push back, then agrees to it on accept_counter", async () => {
    const { agent, merchants, fake } = setup();
    const { ref, stripe_charge_id } = await merchants.book(hotelRequest());

    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    const second = await agent.respond(pushBack(2), DEMO_NOW);
    expect(second).toMatchObject({ type: "counter", kind: "partial_refund", amount: 54400, round: 2 });
    expect(merchants.getOrder(ref)?.status).toBe("confirmed");

    const third = await agent.respond(acceptCounter(3), DEMO_NOW);
    expect(third).toMatchObject({ type: "accept", refund_amount: 54400, round: 3 });
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refund_amount: 54400 });
  });

  it("never needs more than 3 rounds", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    const replies: MerchantProtocolMessage[] = [
      await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW),
      await agent.respond(pushBack(2), DEMO_NOW),
      await agent.respond(acceptCounter(3), DEMO_NOW),
    ];
    expect(Math.max(...replies.map((r) => r.round))).toBeLessThanOrEqual(3);
    expect(replies.map((r) => r.type)).toEqual(["counter", "counter", "accept"]);
  });

  it("clears the partial refund against the human's preference of 80%", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    const offer = (await agent.respond(pushBack(2), DEMO_NOW)) as { amount: number };
    expect((offer.amount / 64000) * 100).toBeGreaterThanOrEqual(80);
  });

  it("holds the same offer if pushed back again, and agrees the refund only once", async () => {
    const { agent, merchants, fake } = setup();
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    await agent.respond(pushBack(2), DEMO_NOW);
    const again = await agent.respond(pushBack(3), DEMO_NOW);
    expect(again).toMatchObject({ type: "counter", kind: "partial_refund", amount: 54400 });

    await agent.respond(acceptCounter(3), DEMO_NOW);
    const replay = await agent.respond(acceptCounter(3), DEMO_NOW);
    expect(replay).toMatchObject({ type: "deny", reason: "No open negotiation." });
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refund_amount: 54400 });
  });

  it("repeats the standing offer while Proxy asks the human", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    expect(await agent.respond(askHuman(2), DEMO_NOW)).toMatchObject({ type: "counter", kind: "store_credit", amount: 64000 });
  });

  it("honors a store-credit acceptance without moving money through Stripe", async () => {
    const { agent, merchants, fake } = setup();
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    const reply = await agent.respond(acceptCounter(2), DEMO_NOW);
    expect(reply).toMatchObject({ type: "accept", refund_amount: 0 });
    expect(merchants.getOrder(ref)).toMatchObject({ status: "credited", refund_amount: 0 });
    expect(merchants.getOrder(ref)?.status).toBe("credited");
  });

  it("supports a different partial refund percentage", async () => {
    const { agent, merchants } = setup({ partial_refund_pct: 90 });
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    expect(await agent.respond(pushBack(2), DEMO_NOW)).toMatchObject({ amount: 57600 });
  });
});

describe("hotel agent: other behaviors and refusals", () => {
  it("accepts a full refund straight away when configured to", async () => {
    const { agent, merchants, fake } = setup({ behavior: "accept_full" });
    const { ref } = await merchants.book(hotelRequest());
    expect(await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW)).toMatchObject({ type: "accept", refund_amount: 64000, round: 1 });
    expect(merchants.getOrder(ref)).toMatchObject({ status: "cancelled", refund_amount: 64000 });
  });

  it("denies when configured to", async () => {
    const { agent, merchants, fake } = setup({ behavior: "deny" });
    const { ref } = await merchants.book(hotelRequest());
    expect(await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW)).toMatchObject({ type: "deny" });
    expect(merchants.getOrder(ref)?.status).toBe("confirmed");
  });

  it("denies an unknown booking reference", async () => {
    const { agent } = setup();
    expect(await agent.respond(requestReversal("HTL-NOPE00", "hotel", 64000), DEMO_NOW)).toMatchObject({
      type: "deny",
      reason: "Unknown booking reference.",
    });
  });

  it("denies a booking that was already refunded", async () => {
    const { agent, merchants } = setup({ behavior: "accept_full" });
    const { ref } = await merchants.book(hotelRequest());
    await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    const second = await agent.respond(requestReversal(ref, "hotel", 64000, { negotiation_id: "neg_2" }), DEMO_NOW);
    expect(second).toMatchObject({ type: "deny", reason: "This booking has already been refunded or cancelled." });
  });

  it("accepts requests up to 24 hours before check-in and denies after", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    const onTime = await agent.respond(requestReversal(ref, "hotel", 64000), "2026-11-02T00:00:00.000Z");
    expect(onTime.type).toBe("counter");

    const second = setup();
    const booked = await second.merchants.book(hotelRequest());
    const late = await second.agent.respond(requestReversal(booked.ref, "hotel", 64000), "2026-11-02T00:00:00.001Z");
    expect(late).toMatchObject({ type: "deny", reason: "Too close to check-in for a goodwill refund." });
  });

  it("denies a push back or accept for a negotiation it never opened", async () => {
    const { agent } = setup();
    expect(await agent.respond(pushBack(2), DEMO_NOW)).toMatchObject({ type: "deny", reason: "No open negotiation." });
    expect(await agent.respond(acceptCounter(2), DEMO_NOW)).toMatchObject({ type: "deny", reason: "No open negotiation." });
  });

  it("always answers with a typed protocol message and never free text", async () => {
    const { agent, merchants } = setup();
    const { ref } = await merchants.book(hotelRequest());
    const replies = [
      await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW),
      await agent.respond(pushBack(2), DEMO_NOW),
      await agent.respond(acceptCounter(3), DEMO_NOW),
      await agent.respond(pushBack(3), DEMO_NOW),
    ];
    for (const reply of replies) {
      expect(["accept", "counter", "deny"]).toContain(reply.type);
      expect(Object.keys(reply).sort()).toEqual(
        expect.arrayContaining(["action_id", "chain_id", "negotiation_id", "round", "sent_at", "type"]),
      );
    }
  });
});

describe("the hotel agent's persona lines", () => {
  async function run(options: HotelAgentOptions = {}) {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps, { hotel: options });
    const { ref } = await merchants.book({
      merchant_id: "hotel",
      task_id: "task_nyc",
      task_email: "task-nyc@proxy.example",
      item: "Harborview Hotel, 3 nights",
      dates: { start: "2026-11-03", end: "2026-11-06" },
      amount: 64000,
      booked_at: "2026-10-17T11:00:00.000Z",
    });
    const agent = merchants.agent("hotel");
    if (!agent) {
      throw new Error("the hotel should have an agent");
    }
    return { agent, ref };
  }
  const lineOf = (reply: unknown): string => String((reply as { message?: unknown }).message ?? "");

  it("says what it is doing in plain words, next to the typed fields", async () => {
    const { agent, ref } = await run();
    const ids = { negotiation_id: "neg_1", chain_id: "chain_act_flight", action_id: "act_hotel", sent_at: DEMO_NOW };
    const request = requestReversal(ref, "hotel", 64000);
    const first = await agent.respond(request, DEMO_NOW);
    expect(first).toMatchObject({ type: "counter", kind: "store_credit", amount: 64000 });
    expect(lineOf(first)).toBe("Rate is non-refundable. We can offer store credit of $640.00.");

    const second = await agent.respond({ ...ids, round: 2, type: "push_back", reason: "no store credit" }, DEMO_NOW);
    expect(second).toMatchObject({ type: "counter", kind: "partial_refund", amount: 54400 });
    expect(lineOf(second)).toBe("As a one-time goodwill exception we can refund 85%, $544.00.");

    const third = await agent.respond({ ...ids, round: 3, type: "accept_counter" }, DEMO_NOW);
    expect(third).toMatchObject({ type: "accept", refund_amount: 54400 });
    expect(lineOf(third)).toBe("Agreed: refunding $544.00.");
  });

  it("says so when it approves a full refund", async () => {
    const { agent, ref } = await run({ behavior: "accept_full" });
    const reply = await agent.respond(requestReversal(ref, "hotel", 64000), DEMO_NOW);
    expect(lineOf(reply)).toBe("Full refund of $640.00 approved.");
  });
});
