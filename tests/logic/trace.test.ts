import { describe, expect, it } from "vitest";
import { compare, trace } from "../../src/logic/index.js";
import type { Action } from "../../src/types.js";
import { FLIGHT_WINDOW_END, demoActions, demoIntent, demoMismatches } from "../helpers/demo.js";

describe("trace: the demo case", () => {
  const intent = demoIntent();
  const actions = demoActions(true);
  const chains = trace(intent, actions, compare(intent, actions));

  it("groups the flight, transfer, host email and hotel into one chain", () => {
    expect(chains).toHaveLength(1);
    expect(chains[0].action_ids).toEqual(["act_flight", "act_transfer", "act_host_email", "act_hotel"]);
  });

  it("makes the earliest booking the root", () => {
    expect(chains[0].root_action_id).toBe("act_flight");
    expect(chains[0].chain_id).toBe("chain_act_flight");
  });

  it("puts $1,240 at risk", () => {
    expect(chains[0].money_at_risk).toBe(124000);
  });

  it("uses the tightest window: the flight's 24-hour refund window", () => {
    expect(chains[0].window_ends_at).toBe(FLIGHT_WINDOW_END);
  });

  it("starts in the detected state with nothing planned yet", () => {
    expect(chains[0]).toMatchObject({ task_id: "task_nyc", state: "detected", alerts: [], plan: [], steps: [] });
  });

  it("gives the same answer for hand-written mismatches", () => {
    expect(trace(intent, actions, demoMismatches())).toEqual(chains);
  });
});

describe("trace: late confirmations and stability", () => {
  const intent = demoIntent();

  it("keeps the same chain id when the late hotel confirmation arrives", () => {
    const withoutHotel = demoActions(true).filter((a) => a.category !== "hotel");
    const before = trace(intent, withoutHotel, compare(intent, withoutHotel));
    const all = demoActions(true);
    const after = trace(intent, all, compare(intent, all));

    expect(before[0].action_ids).toEqual(["act_flight", "act_transfer", "act_host_email"]);
    expect(after[0].chain_id).toBe(before[0].chain_id);
    expect(after[0].action_ids).toContain("act_hotel");
    expect(after[0].money_at_risk).toBe(before[0].money_at_risk + 64000);
  });

  it("does not depend on input order", () => {
    const forward = demoActions(true);
    const shuffled = [forward[3], forward[1], forward[0], forward[2]];
    expect(trace(intent, shuffled, compare(intent, shuffled))).toEqual(trace(intent, forward, compare(intent, forward)));
  });
});

describe("trace: separate mistakes stay separate", () => {
  const intent = demoIntent();

  it("returns no chains when nothing is wrong", () => {
    const actions = demoActions(false);
    expect(trace(intent, actions, compare(intent, actions))).toEqual([]);
  });

  it("does not link a wrong-date action with one whose wrong dates do not overlap", () => {
    const actions = demoActions(true).map((a) => (a.category === "hotel" ? { ...a, dates: { start: "2026-11-20", end: "2026-11-22" } } : a));
    const chains = trace(intent, actions, compare(intent, actions));
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.action_ids)).toEqual([["act_flight", "act_transfer", "act_host_email"], ["act_hotel"]]);
  });

  it("puts a duplicate in its own chain and leaves the original out", () => {
    const roomy = demoIntent({ constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 300000 } });
    const [flight] = demoActions(false);
    const second: Action = { ...flight, action_id: "act_flight_2", ref: "AIR-DEMO02", received_at: "2026-10-17T09:40:00.000Z" };
    const actions = [...demoActions(false), second];
    const chains = trace(roomy, actions, compare(roomy, actions));
    expect(chains).toHaveLength(1);
    expect(chains[0].action_ids).toEqual(["act_flight_2"]);
  });

  it("ignores mismatches for actions that are not in the list", () => {
    const stray = [{ action_id: "act_missing", field: "dates" as const, expected: "2026-11-13", actual: "2026-11-03" }];
    expect(trace(intent, demoActions(false), stray)).toEqual([]);
  });

  it("leaves window_ends_at null when no member has a window", () => {
    const message = demoActions(true).filter((a) => a.category === "message");
    const chains = trace(intent, message, compare(intent, message));
    expect(chains[0].window_ends_at).toBeNull();
  });
});
