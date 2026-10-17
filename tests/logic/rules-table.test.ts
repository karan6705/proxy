import { describe, expect, it } from "vitest";
import { reversibility } from "../../src/logic/index.js";
import {
  RULES_TABLE,
  type RuleKey,
  costOf,
  getRule,
  ruleKeyForAction,
  ruleKeyForCategory,
} from "../../src/logic/rules-table.js";
import type { Action, ActionCategory, RouteKind } from "../../src/types.js";
import { DEMO_NOW, demoActions } from "../helpers/demo.js";

const HOUR = 60 * 60 * 1000;
const ROUTES: RouteKind[] = ["reversal_protocol", "email_support", "self_serve", "correction", "stripe_dispute"];
const KEYS: RuleKey[] = ["airline", "hotel", "transfer", "saas", "store", "domain", "final_sale", "message"];
const CATEGORIES: ActionCategory[] = ["flight", "hotel", "transfer", "saas", "store", "message"];

const [flight, transfer, , hotel] = demoActions(true);
const plusHours = (ts: string, hours: number): string => new Date(Date.parse(ts) + hours * HOUR).toISOString();
const plain = (overrides: Partial<Action>): Action => ({ ...flight, dates: undefined, ...overrides });

describe("rules table: shape", () => {
  it("has an entry for every merchant type, keyed by its own name", () => {
    expect(Object.keys(RULES_TABLE).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      expect(getRule(key).key).toBe(key);
    }
  });

  it("gives every entry a valid route, a rule and a basis", () => {
    for (const entry of Object.values(RULES_TABLE)) {
      expect(ROUTES).toContain(entry.route);
      expect(entry.rule.length).toBeGreaterThan(0);
      expect(entry.basis.length).toBeGreaterThan(0);
    }
  });

  it("maps every ActionCategory to a table entry", () => {
    for (const category of CATEGORIES) {
      expect(RULES_TABLE[ruleKeyForCategory(category)]).toBeDefined();
    }
    expect(ruleKeyForCategory("flight")).toBe("airline");
  });

  it("only gives an entry no window when it is not time-limited", () => {
    const noWindow = Object.values(RULES_TABLE).filter((e) => e.window === null).map((e) => e.key).sort();
    expect(noWindow).toEqual(["final_sale", "message"]);
  });
});

describe("rules table: the entries the brief asks for", () => {
  it("airline: self-serve 24-hour full refund, then a $75 change fee until 24h before departure", () => {
    const airline = getRule("airline");
    expect(airline).toMatchObject({ route: "self_serve", reversible: true, refundable: true });
    expect(airline.window).toEqual({ anchor: "booking", hours: 24, direction: "after" });
    expect(airline.conditions[0]).toContain("7 days");
    expect(airline.after_window?.cost_to_undo).toEqual({ type: "flat", cents: 7500 });
    expect(airline.after_window?.window).toEqual({ anchor: "departure", hours: 24, direction: "before" });
  });

  it("hotel: negotiated through the Reversal Protocol, non-refundable by default, until 24h before check-in", () => {
    const hotelRule = getRule("hotel");
    expect(hotelRule).toMatchObject({ route: "reversal_protocol", refundable: false });
    expect(hotelRule.window).toEqual({ anchor: "check_in", hours: 24, direction: "before" });
  });

  it("transfer: cancelled by email until 24h before pickup", () => {
    expect(getRule("transfer")).toMatchObject({ route: "email_support", refundable: true });
    expect(getRule("transfer").window).toEqual({ anchor: "pickup", hours: 24, direction: "before" });
  });

  it("SaaS: a 14-day refund window", () => {
    expect(getRule("saas").window).toEqual({ anchor: "booking", hours: 14 * 24, direction: "after" });
  });

  it("domain: a 5-day Add Grace Period, deleted through the registrar", () => {
    expect(getRule("domain")).toMatchObject({ route: "self_serve", reversible: true, refundable: true });
    expect(getRule("domain").window).toEqual({ anchor: "registration", hours: 120, direction: "after" });
  });

  it("final sale: not reversible, the whole price is lost, so go straight to the damage minimizer", () => {
    const finalSale = getRule("final_sale");
    expect(finalSale).toMatchObject({ reversible: false, refundable: false, window: null, after_window: null });
    expect(costOf(finalSale.cost_to_undo, 12345)).toBe(12345);
  });
});

describe("costOf", () => {
  it("is zero for none, the price for full, and a rounded share for a percentage", () => {
    expect(costOf({ type: "none" }, 20000)).toBe(0);
    expect(costOf({ type: "full" }, 20000)).toBe(20000);
    expect(costOf({ type: "percent", fraction: 0.15 }, 20000)).toBe(3000);
    expect(costOf({ type: "percent", fraction: 0.15 }, 999)).toBe(150);
  });

  it("never charges a flat fee above the price", () => {
    expect(costOf({ type: "flat", cents: 7500 }, 41200)).toBe(7500);
    expect(costOf({ type: "flat", cents: 7500 }, 5000)).toBe(5000);
  });
});

describe("rules table agrees with reversibility()", () => {
  it("airline: the primary window is 24 hours after the booking was captured", () => {
    const window = getRule("airline").window;
    expect(reversibility(flight, DEMO_NOW).window_ends_at).toBe(plusHours(flight.received_at, window?.hours ?? 0));
  });

  it("airline: the change fee and cutoff after the window match", () => {
    const after = getRule("airline").after_window;
    const result = reversibility(flight, plusHours(flight.received_at, 25));
    expect(result.kind).toBe("change");
    expect(result.cost_to_reverse).toBe(costOf(after?.cost_to_undo ?? { type: "none" }, flight.amount));
    expect(result.window_ends_at).toBe("2026-11-02T00:00:00.000Z");
  });

  it("hotel: the window ends 24 hours before check-in", () => {
    expect(reversibility(hotel, DEMO_NOW).window_ends_at).toBe("2026-11-02T00:00:00.000Z");
    expect(reversibility(hotel, DEMO_NOW).refundable).toBe(getRule("hotel").refundable);
  });

  it("transfer: the window ends 24 hours before pickup", () => {
    expect(reversibility(transfer, DEMO_NOW).window_ends_at).toBe("2026-11-02T00:00:00.000Z");
    expect(reversibility(transfer, DEMO_NOW).refundable).toBe(getRule("transfer").refundable);
  });

  it("SaaS: the refund window is 14 days", () => {
    const saas = plain({ category: "saas", merchant: "saas", amount: 24000 });
    const hours = getRule("saas").window?.hours ?? 0;
    expect(reversibility(saas, DEMO_NOW).window_ends_at).toBe(plusHours(saas.received_at, hours));
  });

  it("store: free return window, then the restocking fee from the table", () => {
    const store = plain({ category: "store", merchant: "store", amount: 20000 });
    const entry = getRule("store");
    expect(reversibility(store, DEMO_NOW).window_ends_at).toBe(plusHours(store.received_at, entry.window?.hours ?? 0));

    const late = reversibility(store, plusHours(store.received_at, 45 * 24));
    expect(late.cost_to_reverse).toBe(costOf(entry.after_window?.cost_to_undo ?? { type: "none" }, store.amount));
    expect(late.window_ends_at).toBe(plusHours(store.received_at, entry.after_window?.window?.hours ?? 0));
  });

  it("message: always correctable, no window", () => {
    const message = plain({ category: "message", merchant: "host", amount: 0 });
    expect(reversibility(message, DEMO_NOW)).toMatchObject({ kind: "correct_message", window_ends_at: null });
    expect(getRule("message").window).toBeNull();
  });
});

describe("rules table: keyed by merchant, then category", () => {
  it("uses the entry named by the merchant id when there is one", () => {
    expect(ruleKeyForAction({ merchant: "final_sale", category: "store" })).toBe("final_sale");
  });

  it("falls back to the category for any other merchant", () => {
    expect(ruleKeyForAction({ merchant: "Acme Outfitters", category: "store" })).toBe("store");
    expect(ruleKeyForAction({ merchant: "Skyline Demo Air", category: "flight" })).toBe("airline");
  });

  it("makes a final-sale item not reversible, whatever its category's window says", () => {
    const item: Action = { ...flight, merchant: "final_sale", category: "store", dates: undefined, amount: 9900 };
    expect(reversibility(item, item.received_at)).toMatchObject({ kind: "none", window_ends_at: null, refundable: false, cost_to_reverse: 0 });
    expect(reversibility(item, item.received_at).rule).toContain("not reversible");
  });
});
