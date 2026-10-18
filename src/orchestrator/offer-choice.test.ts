// Proxy never accepts a merchant offer on its own: at the merchant's final position it texts the human every offer,
// numbered, with its recommendation, and acts only on the reply (1, 2, KEEP PUSHING, or YES / NO).
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import type { Action, MerchantProtocolMessage, ProxyProtocolMessage, SimulatedClock } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";

const HUMAN = "+15555550100";
const PREFS = { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false };
const LATE = "2026-11-01T20:19:15.000Z";
const OPTIONS = "Harborview Hotel's best offer:\n1) Refund $544 (85%) to your card\n2) $640 store credit at Harborview Hotel\nYour rules prefer refunds, so I recommend 1. Reply 1 or 2.";

let clock: SimulatedClock;
let rt: Runtime;
let inkbox: ReturnType<typeof createStandInInkbox>;
let task_id: string;
let hotel: Action;
let transfer: Action;

const texts = () => inkbox.outbox.flatMap((o) => (o.kind === "text" ? [o.body] : []));
const say = (body: string) => rt.human.handleInbound({ from: HUMAN, body, via: "imessage" });
const state = async (a: Action) => (await rt.store.getAction(a.action_id))?.state;
const until = async (done: () => boolean | Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting");
};
const sentToHotel = () => rt.proxy.feed.list(task_id).filter((e) => e.kind === "protocol_out").map((e) => `${e.data.type}@${e.data.round}`);

/** A chain with the hotel and the transfer; the human replies UNDO ALL. */
async function start(env: Record<string, string> = {}, overrides: RuntimeOverrides = {}) {
  clock = createSimulatedClock(LATE);
  inkbox = createStandInInkbox();
  rt = createRuntime(clock, DEFAULT_PARAMS, PREFS, {
    env: { HUMAN_PHONE: HUMAN, PROXY_ALERT_SETTLE_MS: "0", PROXY_DEMO_ROUTES: "1", PROXY_DEMO_REDO: "0", ...env },
    store: createMemoryStore(),
    inkbox,
    ...overrides,
  });
  const tools = createToolHandlers(() => rt.proxy);
  const logged = (await tools.log_intent({ goal: "NYC trip", constraints: { dates: { start: "2026-11-13", end: "2026-11-16" } }, preferences: PREFS, idempotency_key: `oc:${Math.random()}` })).structuredContent as { task_id: string; task_email: string };
  task_id = logged.task_id;
  rt.proxy.deps.sessions.end(task_id);
  const book = async (merchant_id: string, category: Action["category"], amount: number, dates: Action["dates"]) => {
    const b = await rt.merchants.book({ merchant_id, task_id, task_email: logged.task_email, item: `${category}, Nov 3`, dates, amount, booked_at: clock.now(), defer_confirmation: true });
    const action: Action = { action_id: `act_${task_id}_${b.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, task_id, merchant: merchant_id, category, summary: `${category}, Nov 3`, amount, dates, ref: b.ref, source: "email", received_at: clock.now(), state: "found" };
    await rt.proxy.onAction(action);
    return action;
  };
  hotel = await book("hotel", "hotel", 64_000, { start: "2026-11-03", end: "2026-11-06" });
  transfer = await book("transfer", "transfer", 18_800, { start: "2026-11-03" });
  await rt.proxy.alertChains(task_id);
  await say("UNDO ALL");
}

describe("Proxy asks the human before accepting any merchant offer", () => {
  beforeEach(() => undefined);

  it("texts every offer with its recommendation, and accepts nothing until the human answers", async () => {
    await start();
    await until(() => texts().includes(OPTIONS));
    // Paused, not accepted: the request and two push backs went out, no accept_counter.
    expect(sentToHotel()).toEqual(["request_reversal@1", "push_back@2", "push_back@3"]);
    expect(await state(hotel)).toBe("countered");
    // The rest of the chain carries on meanwhile.
    await until(async () => (await state(transfer)) === "verified");
    expect(rt.fakePayments!.refunds.size).toBe(1);
  });

  it("reply 1: the refund is accepted through the protocol, refunded and verified", async () => {
    await start();
    await until(() => texts().includes(OPTIONS));
    await say("1");
    await until(async () => (await state(hotel)) === "verified");
    expect(sentToHotel().at(-1)).toBe("accept_counter@4");
    expect(texts()).toContain("Okay: refund $544 (85%) to your card. Accepting it with Harborview Hotel's agent; I'll text you when Stripe confirms.");
    expect([...rt.fakePayments!.refunds.values()].map((r) => r.amount).sort()).toEqual([18_800, 54_400]);
    expect(rt.proxy.feed.list(task_id).find((e) => e.kind === "decision")?.text).toBe("You chose: Refund $544 (85%) to your card.");
    await until(() => texts().some((t) => t.startsWith("All done.")));
    expect(texts().find((t) => t.startsWith("All done."))).toMatch(/^All done\. \$732 of \$828 back, confirmed in Stripe\./);
  });

  it("reply 2: the store credit is accepted, kept as credit, never refunded or counted as money back", async () => {
    await start();
    await until(() => texts().includes(OPTIONS));
    await say("2");
    await until(async () => (await state(hotel)) === "kept");
    expect(texts()).toContain("Harborview Hotel issued $640 in store credit, as you chose. No money moves to your card.");
    // Only the transfer moved money.
    await until(async () => (await state(transfer)) === "verified");
    expect([...rt.fakePayments!.refunds.values()].map((r) => r.amount)).toEqual([18_800]);
    const chain = (await rt.store.listChains(task_id))[0]!;
    expect(chain.plan.find((p) => p.action_id === hotel.action_id)?.credit_amount).toBe(64_000);
    await until(() => texts().some((t) => t.startsWith("All done.")));
    expect(texts().find((t) => t.startsWith("All done."))).toMatch(/^All done\. \$188 of \$828 back, confirmed in Stripe, plus \$640 as store credit\./);
    expect(rt.proxy.feed.list(task_id).filter((e) => e.kind === "stripe_refund").map((e) => e.data.merchant)).toEqual(["transfer"]);
  });

  it("KEEP PUSHING with no round left says so and asks again; it never accepts on its own", async () => {
    await start();
    await until(() => texts().includes(OPTIONS));
    await say("KEEP PUSHING");
    await until(() => texts().includes("That's Harborview Hotel's final offer: there are no rounds left to push."));
    await until(() => texts().filter((t) => t === OPTIONS).length === 2);
    expect(sentToHotel()).toEqual(["request_reversal@1", "push_back@2", "push_back@3"]);
    await say("1");
    await until(async () => (await state(hotel)) === "verified");
  });

  it("KEEP PUSHING with a round left pushes once more, then asks with every offer, and the human's pick is accepted", async () => {
    // A merchant that offers 85% at once, holds once, and improves to 90% when the human has Proxy push again.
    let improved = false;
    const answer = (m: ProxyProtocolMessage): MerchantProtocolMessage | null => {
      const env = { negotiation_id: m.negotiation_id, chain_id: m.chain_id, action_id: m.action_id, round: m.round, sent_at: clock.now() };
      if (m.type === "request_reversal") return { ...env, type: "counter", kind: "partial_refund", amount: 54_400 };
      if (m.type === "push_back" && /asked us to push once more/.test(m.reason) === false && !improved && m.round === 2) return { ...env, type: "counter", kind: "partial_refund", amount: 54_400 };
      if (m.type === "push_back") {
        improved = true;
        return { ...env, type: "counter", kind: "partial_refund", amount: 57_600 };
      }
      if (m.type === "accept_counter") return { ...env, type: "accept", refund_amount: m.counter?.amount ?? 0 };
      return null;
    };
    await start({}, {
      transport: {
        async send(_merchant, _to, message) {
          const reply = answer(message);
          if (reply) setImmediate(() => void rt.proxy.onProtocolMessage(reply));
        },
      },
    });
    const first = "Harborview Hotel's best offer:\n1) Refund $544 (85%) to your card\nYour rules prefer refunds, so I recommend 1. Reply 1, or KEEP PUSHING.";
    await until(() => texts().includes(first));
    await say("KEEP PUSHING");
    const second = "Harborview Hotel's best offer:\n1) Refund $576 (90%) to your card\n2) Refund $544 (85%) to your card\nYour rules prefer refunds, so I recommend 1. Reply 1 or 2.";
    await until(() => texts().includes(second));
    expect(rt.proxy.feed.list(task_id).filter((e) => e.kind === "protocol_out").map((e) => e.text).at(-1)).toBe("Proxy: our customer asked us to push once more. Can you do better than $544?");
    await say("1");
    await until(async () => (await state(hotel)) === "verified");
    expect(sentToHotel()).toEqual(["request_reversal@1", "push_back@2", "push_back@3", "accept_counter@4"]);
    expect([...rt.fakePayments!.refunds.values()].map((r) => r.amount)).toContain(57_600);
  });

  it("no answer: one reminder with the same options, and still no accept", async () => {
    await start({ PROXY_COUNTER_REMIND_MS: "30" });
    await until(() => texts().includes(OPTIONS));
    await until(() => texts().includes(`Still waiting on your choice. ${OPTIONS}`));
    await new Promise((r) => setTimeout(r, 100));
    expect(texts().filter((t) => t.startsWith("Still waiting on your choice.")).length).toBe(1);
    expect(sentToHotel()).not.toContain("accept_counter@4");
    expect(await state(hotel)).toBe("countered");
    // The merchant timeout doesn't fire while the human decides: no follow-up email, no giving up.
    expect(texts().some((t) => /hasn't answered|never answered/.test(t))).toBe(false);
  });

  it("routing: with the offer question open, a 1 is the choice, not a PICK or an intent answer, on the current run's chain", async () => {
    await start();
    await until(() => texts().includes(OPTIONS));
    // UNDO ALL already started this chain, so a bare 1 used to be read as a PICK number; now it answers the question.
    const result = await say("1");
    expect(result).toMatchObject({ status: "forwarded", kind: "counter_decision" });
    await until(async () => (await state(hotel)) === "verified");
    // It was not taken as a PICK of item 1, and it was the only decision made.
    expect(texts().some((t) => /^Got it\. Undoing 1/.test(t))).toBe(false);
    expect(rt.proxy.feed.list(task_id).filter((e) => e.kind === "decision")).toHaveLength(1);
  });
});
