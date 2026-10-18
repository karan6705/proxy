import { describe, expect, it } from "vitest";
import { compare, logic, planUndo, reversibility, trace } from "../../src/logic/index.js";
import type { Action, Preferences } from "../../src/types.js";
import { DEMO_NOW, FLIGHT_WINDOW_END, PREFERENCES, demoActions, demoIntent, makeChain } from "../helpers/demo.js";

const NOV_2 = "2026-11-02T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const plus = (ts: string, ms: number): string => new Date(Date.parse(ts) + ms).toISOString();

const demoChain = () => {
  const intent = demoIntent();
  const actions = demoActions(true);
  return { actions, chain: trace(intent, actions, compare(intent, actions))[0] };
};

function chainOf(actions: Action[]) {
  return makeChain({ chain_id: "chain_test", action_ids: actions.map((a) => a.action_id), root_action_id: actions[0].action_id });
}

const base = (overrides: Partial<Action>): Action => ({
  action_id: "act_x",
  task_id: "task_nyc",
  merchant: "store",
  category: "store",
  summary: "Rain jacket",
  amount: 20000,
  ref: "STO-1",
  source: "email",
  received_at: "2026-10-17T10:00:00.000Z",
  state: "found",
  ...overrides,
});

describe("plan_undo: the demo chain", () => {
  it("plans the flight by self-serve, the hotel by protocol, the transfer by email and the host by correction, most urgent first", () => {
    const { chain, actions } = demoChain();
    expect(planUndo(chain, actions, PREFERENCES, DEMO_NOW)).toEqual([
      { action_id: "act_flight", route: "self_serve", option: "cancel", cost: 0, deadline: FLIGHT_WINDOW_END },
      { action_id: "act_hotel", route: "reversal_protocol", option: "cancel", cost: 0, deadline: NOV_2 },
      { action_id: "act_transfer", route: "email_support", option: "cancel", cost: 0, deadline: NOV_2 },
      { action_id: "act_host_email", route: "correction", option: "change", cost: 0, deadline: null },
    ]);
  });

  it("is the Logic.plan_undo of the exported logic object, with the Contract v2 arguments", () => {
    const { chain, actions } = demoChain();
    expect(logic.plan_undo(chain, actions, PREFERENCES, DEMO_NOW)).toEqual(planUndo(chain, actions, PREFERENCES, DEMO_NOW));
  });

  it("only plans the actions in the chain, even if more actions are passed", () => {
    const { chain, actions } = demoChain();
    const extra = base({ action_id: "act_other" });
    const plan = planUndo(chain, [...actions, extra], PREFERENCES, DEMO_NOW);
    expect(plan.map((s) => s.action_id)).not.toContain("act_other");
    expect(plan).toHaveLength(4);
  });

  it("skips actions that are already verified or kept", () => {
    const { chain, actions } = demoChain();
    const settled = actions.map((a) => (a.category === "flight" ? { ...a, state: "verified" as const } : a.category === "message" ? { ...a, state: "kept" as const } : a));
    expect(planUndo(chain, settled, PREFERENCES, DEMO_NOW).map((s) => s.action_id)).toEqual(["act_hotel", "act_transfer"]);
  });

  it("does not depend on the order the actions are passed in", () => {
    const { chain, actions } = demoChain();
    expect(planUndo(chain, [...actions].reverse(), PREFERENCES, DEMO_NOW)).toEqual(planUndo(chain, actions, PREFERENCES, DEMO_NOW));
  });

  it("does not change with the negotiation preferences: negotiate_step applies those", () => {
    const { chain, actions } = demoChain();
    const other: Preferences = { no_store_credit: false, min_partial_refund_pct: 10, auto_undo: true };
    expect(planUndo(chain, actions, other, DEMO_NOW)).toEqual(planUndo(chain, actions, PREFERENCES, DEMO_NOW));
  });

  it("does not mutate the chain or the actions", () => {
    const { chain, actions } = demoChain();
    const before = JSON.stringify({ chain, actions });
    planUndo(chain, actions, PREFERENCES, DEMO_NOW);
    expect(JSON.stringify({ chain, actions })).toBe(before);
  });

  it("throws, naming the ids, when the chain's actions were not passed in", () => {
    const { chain, actions } = demoChain();
    expect(() => planUndo(chain, actions.filter((a) => a.action_id !== "act_hotel"), PREFERENCES, DEMO_NOW)).toThrow(/act_hotel/);
  });
});

describe("plan_undo: closed windows and the damage minimizer", () => {
  const flight = demoActions(true)[0];

  it("keeps the flight once the 24-hour window has closed: a $75 change exists, but the airline has no desk to ask", () => {
    const now = plus(flight.received_at, 30 * 60 * 60 * 1000);
    expect(planUndo(chainOf([flight]), [flight], PREFERENCES, now)).toEqual([
      { action_id: "act_flight", route: "keep", option: "keep", cost: 41200, deadline: null },
    ]);
    // reversibility still tells the truth about the fare: it can be changed for $75. Only the human can do it.
    expect(reversibility(flight, now)).toMatchObject({ kind: "change", cost_to_reverse: 7500 });
  });

  it("still takes a fee fix for a merchant that has a desk, once the free window has closed", () => {
    const jacket = { ...flight, action_id: "act_jacket", merchant: "store", category: "store" as const, amount: 20000, received_at: "2026-10-17T09:00:00.000Z", summary: "Rain jacket", dates: { start: "2026-10-17" } };
    const plan = planUndo(chainOf([jacket]), [jacket], PREFERENCES, "2026-12-01T10:00:00.000Z");
    expect(plan[0]).toMatchObject({ option: "cancel", cost: 3000 });
    expect(plan[0].route).not.toBe("keep");
  });

  it("does the same for a flight booked less than 7 days out, where the 24-hour rule never applied", () => {
    const lastMinute = { ...flight, received_at: "2026-10-30T12:00:00.000Z" };
    expect(planUndo(chainOf([lastMinute]), [lastMinute], PREFERENCES, lastMinute.received_at)).toEqual([
      { action_id: "act_flight", route: "keep", option: "keep", cost: 41200, deadline: null },
    ]);
  });

  it("keeps a fare when the change fee is as much as the fare", () => {
    const cheap = { ...flight, amount: 5000, received_at: "2026-10-30T12:00:00.000Z" };
    expect(planUndo(chainOf([cheap]), [cheap], PREFERENCES, cheap.received_at)).toEqual([
      { action_id: "act_flight", route: "keep", option: "keep", cost: 5000, deadline: null },
    ]);
  });

  it("keeps everything that can no longer be changed, and puts the biggest loss first", () => {
    const { actions } = demoChain();
    const chain = chainOf(actions);
    const plan = planUndo(chain, actions, PREFERENCES, "2026-11-02T12:00:00.000Z");
    const keeps = plan.filter((s) => s.option === "keep");
    expect(keeps.map((s) => s.action_id)).toEqual(["act_hotel", "act_flight", "act_transfer"]);
    expect(keeps.map((s) => s.cost)).toEqual([64000, 41200, 18800]);
    expect(keeps.every((s) => s.deadline === null && s.route === "keep")).toBe(true);
    // The correction message is still a fix, so it comes before the keeps.
    expect(plan[0]).toMatchObject({ action_id: "act_host_email", route: "correction" });
  });

  it("returns a late store item for a 15% restocking fee when that beats losing the price", () => {
    const store = base({});
    const now = plus(store.received_at, 45 * DAY);
    expect(planUndo(chainOf([store]), [store], PREFERENCES, now)).toEqual([
      { action_id: "act_x", route: "email_support", option: "cancel", cost: 3000, deadline: plus(store.received_at, 60 * DAY) },
    ]);
  });

  it("returns a store item free inside 30 days, then keeps it after day 60", () => {
    const store = base({});
    expect(planUndo(chainOf([store]), [store], PREFERENCES, plus(store.received_at, 10 * DAY))[0]).toMatchObject({ option: "cancel", cost: 0 });
    expect(planUndo(chainOf([store]), [store], PREFERENCES, plus(store.received_at, 61 * DAY))[0]).toMatchObject({ option: "keep", cost: 20000 });
  });

  it("cancels a SaaS plan inside 14 days by email, and keeps it after", () => {
    const plan = base({ merchant: "saas", category: "saas", summary: "Acme Pro, billed annually", amount: 24000 });
    expect(planUndo(chainOf([plan]), [plan], PREFERENCES, plus(plan.received_at, 10 * DAY))[0]).toMatchObject({
      route: "email_support",
      option: "cancel",
      cost: 0,
      deadline: plus(plan.received_at, 14 * DAY),
    });
    expect(planUndo(chainOf([plan]), [plan], PREFERENCES, plus(plan.received_at, 15 * DAY))[0]).toMatchObject({ option: "keep", cost: 24000 });
  });

  it("goes straight to keep for a final-sale item, even inside what would be a return window", () => {
    const finalSale = base({ action_id: "act_final", merchant: "final_sale", amount: 9900 });
    expect(planUndo(chainOf([finalSale]), [finalSale], PREFERENCES, plus(finalSale.received_at, DAY))).toEqual([
      { action_id: "act_final", route: "keep", option: "keep", cost: 9900, deadline: null },
    ]);
  });
});
