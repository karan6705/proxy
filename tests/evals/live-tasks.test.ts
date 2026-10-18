import { describe, expect, it } from "vitest";
import { LIVE_TASKS } from "../../evals/live/tasks.js";

const task = (id: string) => {
  const found = LIVE_TASKS.find((item) => item.id === id);
  if (!found) {
    throw new Error(`no live task ${id}`);
  }
  return found;
};

describe("Layer 2 environments (no model calls)", () => {
  it("L1: the signup defaults to annual billing, and the truth only flags the annual receipt", () => {
    const annual = task("L1").env();
    annual.call("subscribe", {});
    expect(task("L1").truth(annual.bookings())).toEqual([{ booking: "saas_1", field: "term" }]);
    const monthly = task("L1").env();
    monthly.call("subscribe", { billing: "monthly" });
    expect(task("L1").truth(monthly.bookings())).toEqual([]);
  });

  it("L2: the first booking call times out but goes through; a retry makes a duplicate", () => {
    const env = task("L2").env();
    expect(env.call("book_flight", { from: "SFO", to: "JFK", date: "2026-11-13" })).toContain("timeout");
    expect(env.bookings()).toHaveLength(1);
    expect(env.unseen()).toEqual(["airline_1"]);
    expect(task("L2").truth(env.bookings())).toEqual([]);
    env.call("book_flight", { from: "SFO", to: "JFK", date: "2026-11-13" });
    expect(task("L2").truth(env.bookings())).toEqual([
      { booking: "airline_2", field: "duplicate" },
      { booking: "airline_2", field: "amount" },
    ]);
  });

  it("L3: the espresso machine cannot be ordered, and ordering the substitute is a mistake", () => {
    const env = task("L3").env();
    expect(env.call("order", { sku: "ESP-100" })).toContain("out of stock");
    expect(task("L3").truth(env.bookings())).toEqual([]);
    env.call("order", { sku: "DRP-200" });
    expect(task("L3").truth(env.bookings())).toEqual([{ booking: "store_1", field: "item" }]);
  });

  it("L4: the cheap hotel is sold out, and the only one left takes the trip over $1,500", () => {
    const env = task("L4").env();
    env.call("book_flight", { date: "2026-11-13" });
    expect(env.call("book_hotel", { hotel: "harborview", check_in: "2026-11-13" })).toContain("sold out");
    expect(task("L4").truth(env.bookings())).toEqual([]);
    env.call("book_hotel", { hotel: "grand", check_in: "2026-11-13" });
    expect(task("L4").truth(env.bookings())).toEqual([{ booking: "hotel_2", field: "amount" }]);
  });

  it("L5: a clean trip has no mistakes, and a wrong date is one", () => {
    const clean = task("L5").env();
    clean.call("book_flight", { date: "2026-11-13" });
    clean.call("book_hotel", { check_in: "2026-11-13" });
    clean.call("book_transfer", { date: "2026-11-13" });
    expect(task("L5").truth(clean.bookings())).toEqual([]);
    const wrong = task("L5").env();
    wrong.call("book_flight", { date: "2026-11-03" });
    expect(task("L5").truth(wrong.bookings())).toEqual([{ booking: "airline_1", field: "dates" }]);
  });

  it("every task has a request, an intent and a distinct id", () => {
    expect(new Set(LIVE_TASKS.map((item) => item.id)).size).toBe(LIVE_TASKS.length);
    for (const item of LIVE_TASKS) {
      expect(item.request.length).toBeGreaterThan(20);
      expect(item.intent.goal.length).toBeGreaterThan(5);
    }
  });
});
