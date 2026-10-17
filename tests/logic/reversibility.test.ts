import { describe, expect, it } from "vitest";
import { reversibility, windowEndsAt } from "../../src/logic/index.js";
import { FLIGHT_CHANGE_FEE } from "../../src/logic/rules.js";
import type { Action } from "../../src/types.js";
import { DEMO_NOW, FLIGHT_WINDOW_END, demoActions } from "../helpers/demo.js";

const [flight, transfer, message, hotel] = demoActions(true);
const NOV_2 = "2026-11-02T00:00:00.000Z"; // 24 hours before a Nov 3 start

const plus = (ts: string, ms: number): string => new Date(Date.parse(ts) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function booked(overrides: Partial<Action>): Action {
  return { ...flight, ...overrides };
}

describe("reversibility: the demo flight (24-hour rule)", () => {
  it("allows a full-refund cancel at 3h 40m before the window closes", () => {
    expect(reversibility(flight, DEMO_NOW)).toEqual({
      kind: "cancel_refund",
      window_ends_at: FLIGHT_WINDOW_END,
      refundable: true,
      cost_to_reverse: 0,
      rule: expect.stringContaining("24-hour rule"),
    });
  });

  it("still allows the cancel at the last moment", () => {
    expect(reversibility(flight, FLIGHT_WINDOW_END).kind).toBe("cancel_refund");
  });

  it("falls back to a $75 change fee one millisecond later", () => {
    const result = reversibility(flight, plus(FLIGHT_WINDOW_END, 1));
    expect(result).toMatchObject({ kind: "change", refundable: false, cost_to_reverse: FLIGHT_CHANGE_FEE, window_ends_at: NOV_2 });
    expect(FLIGHT_CHANGE_FEE).toBe(7500);
  });

  it("caps the change fee at the ticket price", () => {
    const cheap = booked({ amount: 5000 });
    expect(reversibility(cheap, plus(FLIGHT_WINDOW_END, 1)).cost_to_reverse).toBe(5000);
  });

  it("has nothing left once it is less than 24 hours before departure", () => {
    expect(reversibility(flight, plus(NOV_2, 1))).toMatchObject({ kind: "none", window_ends_at: null, refundable: false });
  });
});

describe("reversibility: flights booked less than 7 days out", () => {
  const lastMinute = booked({ received_at: "2026-10-30T12:00:00.000Z" }); // departs Nov 3, under 7 days

  it("gives no 24-hour refund, only a change fee", () => {
    const result = reversibility(lastMinute, lastMinute.received_at);
    expect(result).toMatchObject({ kind: "change", refundable: false, cost_to_reverse: 7500, window_ends_at: NOV_2 });
    expect(result.rule).toContain("7 days");
  });

  it("applies the 24-hour rule at exactly 7 days out", () => {
    const sevenDays = booked({ received_at: "2026-10-27T00:00:00.000Z" }); // exactly 7 days before Nov 3 00:00
    expect(reversibility(sevenDays, sevenDays.received_at).kind).toBe("cancel_refund");
  });

  it("has no window at all when booked inside the change cutoff", () => {
    const veryLate = booked({ received_at: "2026-11-02T20:00:00.000Z" });
    expect(reversibility(veryLate, veryLate.received_at)).toMatchObject({ kind: "none", window_ends_at: null });
  });
});

describe("reversibility: hotel (non-refundable rate, goodwill only)", () => {
  it("is cancelable but not refundable, with no cost to try", () => {
    expect(reversibility(hotel, DEMO_NOW)).toMatchObject({
      kind: "cancel_refund",
      refundable: false,
      cost_to_reverse: 0,
      window_ends_at: NOV_2,
    });
  });

  it("closes 24 hours before check-in", () => {
    expect(reversibility(hotel, NOV_2).kind).toBe("cancel_refund");
    expect(reversibility(hotel, plus(NOV_2, 1)).kind).toBe("none");
  });
});

describe("reversibility: transfer (free cancel until 24h before pickup)", () => {
  it("is cancelable and refundable until Nov 2", () => {
    expect(reversibility(transfer, DEMO_NOW)).toMatchObject({
      kind: "cancel_refund",
      refundable: true,
      cost_to_reverse: 0,
      window_ends_at: NOV_2,
    });
  });

  it("has no refund after the deadline", () => {
    expect(reversibility(transfer, plus(NOV_2, 1))).toMatchObject({ kind: "none", refundable: false });
  });
});

describe("reversibility: the host email", () => {
  it("can always be corrected and has no window", () => {
    expect(reversibility(message, DEMO_NOW)).toEqual({
      kind: "correct_message",
      window_ends_at: null,
      refundable: false,
      cost_to_reverse: 0,
      rule: expect.stringContaining("follow-up"),
    });
    expect(reversibility(message, "2027-01-01T00:00:00.000Z").kind).toBe("correct_message");
  });
});

describe("reversibility: SaaS and store (other categories on the rules table)", () => {
  const saas = booked({ category: "saas", merchant: "saas", dates: undefined, amount: 24000, received_at: "2026-10-17T10:00:00.000Z" });
  const store = booked({ category: "store", merchant: "store", dates: undefined, amount: 20000, received_at: "2026-10-17T10:00:00.000Z" });

  it("refunds SaaS within 14 days and not after", () => {
    expect(reversibility(saas, plus(saas.received_at, 13 * DAY))).toMatchObject({ kind: "cancel_refund", refundable: true });
    expect(reversibility(saas, plus(saas.received_at, 15 * DAY))).toMatchObject({ kind: "none", refundable: false });
  });

  it("returns store items free within 30 days", () => {
    expect(reversibility(store, plus(store.received_at, 10 * DAY))).toMatchObject({ kind: "return", cost_to_reverse: 0, refundable: true });
  });

  it("charges a 15% restocking fee from day 30 to day 60, then nothing", () => {
    expect(reversibility(store, plus(store.received_at, 45 * DAY))).toMatchObject({ kind: "return", cost_to_reverse: 3000 });
    expect(reversibility(store, plus(store.received_at, 61 * DAY)).kind).toBe("none");
  });
});

describe("windowEndsAt", () => {
  it("does not depend on the current time and matches the primary window", () => {
    expect(windowEndsAt(flight)).toBe(FLIGHT_WINDOW_END);
    expect(windowEndsAt(hotel)).toBe(NOV_2);
    expect(windowEndsAt(transfer)).toBe(NOV_2);
    expect(windowEndsAt(message)).toBeNull();
  });

  it("agrees with reversibility() while the primary window is open", () => {
    for (const action of [flight, hotel, transfer]) {
      expect(reversibility(action, DEMO_NOW).window_ends_at).toBe(windowEndsAt(action));
    }
  });
});
