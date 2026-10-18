import { describe, expect, it } from "vitest";
import { compare } from "../../src/logic/index.js";
import { negotiateStep } from "../../src/logic/negotiate-step.js";
import { createFakeDeps, createMerchants, qrMatrix } from "../../src/merchants/index.js";
import type { Action, Intent, NegotiationState, ProxyProtocolMessage, RequestReversal } from "../../src/types.js";

const BOOKED = "2026-10-10T15:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const plus = (ms: number): string => new Date(Date.parse(BOOKED) + ms).toISOString();

async function setup(carrier?: { scan_delay_ms: number }) {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps, carrier ? { carrier } : {});
  const order = await merchants.book({ merchant_id: "northwind", task_id: "task_store", task_email: "task_store@tasks.proxy.example", item: "USB-A 20W charger", amount: 4_500, booked_at: BOOKED });
  return { fake, merchants, order };
}

const envelope = { negotiation_id: "neg_1", chain_id: "chain_1", action_id: "act_1", sent_at: plus(60_000) };
const request = (ref: string): RequestReversal =>
  ({ ...envelope, type: "request_reversal", round: 1, order: { merchant: "northwind", ref, amount: 4_500 } }) as unknown as RequestReversal;

const filled = (ref: string) => ({
  order_number: ref,
  item: "USB-A 20W charger",
  reason: "Wrong item, ordered in error by an AI agent on my behalf",
  resolution: "refund_original",
  method: "drop_off",
});

describe("Northwind Market: the order", () => {
  it("is a store with an agent, charges Stripe, and its receipt is flagged against USB-C 65W", async () => {
    const { fake, merchants, order } = await setup();
    expect(merchants.get("northwind")).toMatchObject({ name: "Northwind Market", category: "store", has_agent: true });
    expect(order.ref).toMatch(/^NWM-[A-Z0-9]{6}$/);
    expect(fake.charges).toHaveLength(1);
    const intent = { task_id: "task_store", constraints: { must_haves: ["item:USB-C 65W charger"] } } as unknown as Intent;
    const action: Action = { action_id: "act_1", task_id: "task_store", merchant: "northwind", category: "store", summary: "USB-A 20W charger", amount: 4_500, ref: order.ref, source: "email", received_at: BOOKED, state: "found" };
    expect(compare(intent, [action])).toMatchObject([{ field: "item", expected: "USB-C 65W charger", actual: "USB-A 20W charger" }]);
    expect(merchants.quote("northwind", "USB-C 65W charger")).toBe(5_200);
    expect(merchants.quote("northwind", "Something else")).toBeNull();
  });
});

describe("Northwind Market: the support agent", () => {
  it("offers store credit, then sends Proxy to the return form; negotiate_step pushes back and ends on the deny", async () => {
    const { merchants, order } = await setup();
    const agent = merchants.agent("northwind")!;
    const counter = await agent.respond(request(order.ref), plus(60_000));
    expect(counter).toMatchObject({ type: "counter", kind: "store_credit", amount: 4_500 });

    const state: NegotiationState = { negotiation_id: "neg_1", chain_id: "chain_1", action_id: "act_1", state: "requested", round: 1, push_backs_used: 0, deadline: plus(DAY), order_amount: 4_500, last_counter: null };
    const prefs = { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false };
    const step1 = negotiateStep(state, counter, prefs);
    expect(step1.outgoing?.type).toBe("push_back");

    const deny = await agent.respond({ ...(step1.outgoing as ProxyProtocolMessage), sent_at: plus(120_000) }, plus(120_000));
    expect(deny.type).toBe("deny");
    expect((deny as unknown as { message: string }).message).toContain("northwindmarket.example/returns");
    expect(negotiateStep(step1.next_state, deny, prefs).next_state.state).toBe("denied");
  });

  it("denies an unknown order", async () => {
    const { merchants } = await setup();
    expect(await merchants.agent("northwind")!.respond(request("NWM-NOPE00"), plus(60_000))).toMatchObject({ type: "deny" });
  });
});

describe("Northwind Market: the return form", () => {
  it("rejects missing fields, a wrong item, an option that is not offered and an unknown order", async () => {
    const { merchants, order } = await setup();
    const portal = merchants.returnPortal("northwind")!;
    expect(portal.submit({}, plus(DAY))).toMatchObject({ ok: false, errors: { order_number: "Required.", method: "Required." } });
    expect(portal.submit({ ...filled(order.ref), item: "USB-C 65W charger" }, plus(DAY))).toMatchObject({ ok: false, errors: { item: "That item is not on this order." } });
    expect(portal.submit({ ...filled(order.ref), resolution: "cash" }, plus(DAY))).toMatchObject({ ok: false, errors: { resolution: "Pick one of the options." } });
    expect(portal.submit(filled("NWM-NOPE00"), plus(DAY))).toMatchObject({ ok: false, errors: { order_number: "We could not find that order." } });
    expect(merchants.returnPortal("store")).toBeNull();
  });

  it("gives an RMA and a label good for 14 days, and agrees no refund before the carrier scan", async () => {
    const { merchants, order } = await setup();
    const portal = merchants.returnPortal("northwind")!;
    const result = portal.submit(filled(order.ref), BOOKED);
    if (!result.ok) throw new Error("submit failed");
    expect(result.label).toMatchObject({ ref: order.ref, carrier: "ParcelPoint", drop_off_by: "2026-10-24" });
    expect(result.label.rma).toMatch(/^RMA-[A-Z0-9]{6}$/);
    expect(portal.receive(result.label.rma, plus(DAY))).toEqual({ approved: false, reason: "The package has not been scanned yet." });
    expect(merchants.getOrder(order.ref)?.status).toBe("confirmed");
  });

  it("the simulated carrier scans after its delay; the store then agrees the full refund, once", async () => {
    const { merchants, order } = await setup({ scan_delay_ms: 0 });
    const scans: string[] = [];
    merchants.onCarrierScan((scan) => scans.push(`${scan.rma}:${scan.event}`));
    const portal = merchants.returnPortal("northwind")!;
    const result = portal.submit(filled(order.ref), BOOKED);
    if (!result.ok) throw new Error("submit failed");
    await new Promise((r) => setTimeout(r, 5));
    expect(scans).toEqual([`${result.label.rma}:Package scanned at drop-off`]);
    expect(portal.receive(result.label.rma, plus(DAY))).toEqual({ approved: true, refund_amount: 4_500 });
    expect(merchants.getOrder(order.ref)).toMatchObject({ status: "cancelled", refund_amount: 4_500 });
    // Asking again repeats the same answer; the order is closed to a second return.
    expect(portal.receive(result.label.rma, plus(DAY))).toEqual({ approved: true, refund_amount: 4_500 });
    expect(portal.submit(filled(order.ref), plus(DAY))).toMatchObject({ ok: false });
  });

  it("refuses a package scanned after the label expired", async () => {
    const { merchants, order } = await setup({ scan_delay_ms: 0 });
    const portal = merchants.returnPortal("northwind")!;
    const result = portal.submit(filled(order.ref), BOOKED);
    if (!result.ok) throw new Error("submit failed");
    await new Promise((r) => setTimeout(r, 5));
    expect(portal.receive(result.label.rma, plus(15 * DAY))).toEqual({ approved: false, reason: "The label has expired." });
  });
});

describe("QR code on the label", () => {
  it("picks the smallest version that fits and draws the three finder patterns", () => {
    expect(qrMatrix("RMA-1")).toHaveLength(21);
    const m = qrMatrix("NWM|RMA-4F7K2Q|NWM-ABC123");
    expect(m).toHaveLength(25);
    const finder = (r: number, c: number) => m[r]![c] && m[r]![c + 6] && m[r + 6]![c] && m[r + 3]![c + 3] && !m[r + 1]![c + 1];
    expect(finder(0, 0) && finder(0, 18) && finder(18, 0)).toBe(true);
    expect(qrMatrix("same")).toEqual(qrMatrix("same"));
    expect(() => qrMatrix("x".repeat(100))).toThrow("QR payload too long");
  });
});
