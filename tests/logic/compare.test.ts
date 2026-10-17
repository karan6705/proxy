import { describe, expect, it } from "vitest";
import { compare } from "../../src/logic/index.js";
import type { Action } from "../../src/types.js";
import { demoActions, demoIntent } from "../helpers/demo.js";

function saas(summary: string, overrides: Partial<Action> = {}): Action {
  return {
    action_id: "act_saas",
    task_id: "task_nyc",
    merchant: "saas",
    category: "saas",
    summary,
    amount: 24000,
    ref: "SAS-1",
    source: "email",
    received_at: "2026-10-17T10:00:00.000Z",
    state: "found",
    ...overrides,
  };
}

describe("compare: the demo case (Nov 3 instead of Nov 13)", () => {
  it("flags all four actions, in the order they were received", () => {
    const mismatches = compare(demoIntent(), demoActions(true));
    expect(mismatches.map((m) => m.action_id)).toEqual(["act_flight", "act_transfer", "act_host_email", "act_hotel"]);
  });

  it("reports the exact expected and actual dates for the flight", () => {
    const flight = compare(demoIntent(), demoActions(true)).find((m) => m.action_id === "act_flight");
    expect(flight).toEqual({ action_id: "act_flight", field: "dates", expected: "2026-11-13", actual: "2026-11-03" });
  });

  it("flags the late hotel confirmation too", () => {
    const hotel = compare(demoIntent(), demoActions(true)).find((m) => m.action_id === "act_hotel");
    expect(hotel).toMatchObject({ field: "dates", expected: "2026-11-13", actual: "2026-11-03" });
  });

  it("flags only dates: the $1,240 total is under the $1,500 budget", () => {
    const fields = new Set(compare(demoIntent(), demoActions(true)).map((m) => m.field));
    expect([...fields]).toEqual(["dates"]);
  });

  it("raises nothing for the same trip booked for Nov 13", () => {
    expect(compare(demoIntent(), demoActions(false))).toEqual([]);
  });

  it("does not depend on the order the actions are passed in", () => {
    const forward = compare(demoIntent(), demoActions(true));
    const reversed = compare(demoIntent(), [...demoActions(true)].reverse());
    expect(reversed).toEqual(forward);
  });

  it("does not compare actions that are already verified or kept", () => {
    const settled = demoActions(true).map((a) => ({ ...a, state: a.category === "flight" ? ("verified" as const) : ("kept" as const) }));
    expect(compare(demoIntent(), settled)).toEqual([]);
  });

  it("skips actions with no dates", () => {
    const noDates = demoActions(true).map(({ dates: _dates, ...rest }) => rest as Action);
    expect(compare(demoIntent(), noDates)).toEqual([]);
  });

  it("skips the date check when the intent has no dates", () => {
    const intent = demoIntent({ constraints: { budget_total: 150000 } });
    expect(compare(intent, demoActions(true))).toEqual([]);
  });
});

describe("compare: date edge cases", () => {
  it("flags a hotel that checks out after the trip ends", () => {
    const actions = demoActions(false).map((a) => (a.category === "hotel" ? { ...a, dates: { start: "2026-11-13", end: "2026-11-17" } } : a));
    expect(compare(demoIntent(), actions)).toEqual([
      { action_id: "act_hotel", field: "dates", expected: "2026-11-16", actual: "2026-11-17" },
    ]);
  });

  it("flags a start date after the trip ends", () => {
    const actions = demoActions(false).map((a) => (a.category === "flight" ? { ...a, dates: { start: "2026-11-20" } } : a));
    expect(compare(demoIntent(), actions)).toEqual([
      { action_id: "act_flight", field: "dates", expected: "2026-11-16", actual: "2026-11-20" },
    ]);
  });
});

describe("compare: budget", () => {
  it("accepts a total exactly equal to the budget", () => {
    const intent = demoIntent({ constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 124000 } });
    expect(compare(intent, demoActions(false))).toEqual([]);
  });

  it("flags the action that crosses the budget by one cent, and only that one", () => {
    const intent = demoIntent({ constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 123999 } });
    expect(compare(intent, demoActions(false))).toEqual([
      { action_id: "act_hotel", field: "amount", expected: 123999, actual: 124000 },
    ]);
  });
});

describe("compare: annual instead of monthly", () => {
  const intent = demoIntent({ constraints: { must_haves: ["term:monthly"] } });

  it("flags an annual plan when the intent wanted monthly", () => {
    expect(compare(intent, [saas("Acme Pro, billed annually")])).toEqual([
      { action_id: "act_saas", field: "term", expected: "monthly", actual: "annual" },
    ]);
  });

  it("accepts a monthly plan", () => {
    expect(compare(intent, [saas("Acme Pro, monthly")])).toEqual([]);
  });

  it("ignores free-text must-haves", () => {
    const loose = demoIntent({ constraints: { must_haves: ["a monthly plan please"] } });
    expect(compare(loose, [saas("Acme Pro, billed annually")])).toEqual([]);
  });
});

describe("compare: wrong item", () => {
  const intent = demoIntent({ constraints: { must_haves: ["size:M"] } });
  const jacket = (summary: string): Action => saas(summary, { action_id: "act_jacket", merchant: "store", category: "store", ref: "STO-1" });

  it("flags a store item that misses a size:value must-have", () => {
    expect(compare(intent, [jacket("Rain jacket, size L")])).toEqual([
      { action_id: "act_jacket", field: "item", expected: "M", actual: "Rain jacket, size L" },
    ]);
  });

  it("accepts the right item, case-insensitively", () => {
    expect(compare(intent, [jacket("Rain jacket, SIZE m")])).toEqual([]);
  });
});

describe("compare: duplicates", () => {
  // A second $412 flight would push the trip over the $1,500 budget, so these tests use a roomier budget
  // to isolate the duplicate check.
  const roomy = demoIntent({ constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 300000 } });

  it("flags a second booking of the same flight and points at the first", () => {
    const [flight] = demoActions(false);
    const second: Action = { ...flight, action_id: "act_flight_2", ref: "AIR-DEMO02", received_at: "2026-10-17T09:40:00.000Z" };
    expect(compare(roomy, [...demoActions(false), second])).toEqual([
      { action_id: "act_flight_2", field: "duplicate", expected: null, actual: "act_flight" },
    ]);
  });

  it("does not treat the same booking ref as a duplicate", () => {
    const [flight] = demoActions(false);
    const same: Action = { ...flight, action_id: "act_flight_copy" };
    expect(compare(roomy, [...demoActions(false), same])).toEqual([]);
  });

  it("still reports the budget when a duplicate pushes the trip over it", () => {
    const [flight] = demoActions(false);
    const second: Action = { ...flight, action_id: "act_flight_2", ref: "AIR-DEMO02", received_at: "2026-10-17T09:40:00.000Z" };
    const fields = compare(demoIntent(), [...demoActions(false), second]).map((m) => `${m.action_id}:${m.field}`);
    expect(fields).toEqual(["act_flight_2:duplicate", "act_hotel:amount"]);
  });

  it("never flags $0 messages as duplicates", () => {
    const [, , message] = demoActions(false);
    const again: Action = { ...message, action_id: "act_host_email_2", ref: "MSG-DEMO02" };
    expect(compare(roomy, [...demoActions(false), again])).toEqual([]);
  });
});
