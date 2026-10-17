import { describe, expect, it } from "vitest";
import { compare, rank, trace } from "../../src/logic/index.js";
import { DEFAULT_MIN_HOURS } from "../../src/logic/rules.js";
import { DEMO_NOW, demoActions, demoIntent, makeChain } from "../helpers/demo.js";

const NOW = "2026-10-18T05:25:00.000Z";
const inMinutes = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

describe("rank: the undo queue", () => {
  it("puts the demo chain ($1,240, 3h 40m left) above a small chain with a distant window", () => {
    const intent = demoIntent();
    const actions = demoActions(true);
    const [demo] = trace(intent, actions, compare(intent, actions));
    const distant = makeChain({ chain_id: "chain_saas", money_at_risk: 24000, window_ends_at: "2026-11-01T00:00:00.000Z" });

    expect(rank([distant, demo], DEMO_NOW).map((c) => c.chain_id)).toEqual([demo.chain_id, "chain_saas"]);
  });

  it("ranks by money divided by time left, so a nearer window beats a bigger sum", () => {
    const big = makeChain({ chain_id: "big", money_at_risk: 100000, window_ends_at: inMinutes(600) }); // 10h left
    const small = makeChain({ chain_id: "small", money_at_risk: 30000, window_ends_at: inMinutes(60) }); // 1h left
    expect(rank([big, small], NOW).map((c) => c.chain_id)).toEqual(["small", "big"]);
  });

  it("floors hours_left at MIN_HOURS, so a closing window does not score infinity", () => {
    const closing = makeChain({ chain_id: "closing", money_at_risk: 10000, window_ends_at: inMinutes(1) });
    const bigger = makeChain({ chain_id: "bigger", money_at_risk: 50000, window_ends_at: inMinutes(60) });
    // closing: 10000 / 0.25h = 40000/h. bigger: 50000 / 1h = 50000/h.
    expect(DEFAULT_MIN_HOURS).toBe(0.25);
    expect(rank([closing, bigger], NOW).map((c) => c.chain_id)).toEqual(["bigger", "closing"]);
  });

  it("keeps a window that already passed at the top (floored), until the chain is marked expired", () => {
    const passed = makeChain({ chain_id: "passed", money_at_risk: 20000, window_ends_at: inMinutes(-30) });
    const open = makeChain({ chain_id: "open", money_at_risk: 20000, window_ends_at: inMinutes(120) });
    expect(rank([open, passed], NOW).map((c) => c.chain_id)).toEqual(["passed", "open"]);
  });

  it("accepts a custom MIN_HOURS", () => {
    const closing = makeChain({ chain_id: "closing", money_at_risk: 10000, window_ends_at: inMinutes(1) });
    const bigger = makeChain({ chain_id: "bigger", money_at_risk: 50000, window_ends_at: inMinutes(60) });
    expect(rank([bigger, closing], NOW, 0.05).map((c) => c.chain_id)).toEqual(["closing", "bigger"]);
  });

  it("scores a chain with no window as 0, so it sorts after chains that are running out", () => {
    const noWindow = makeChain({ chain_id: "no_window", money_at_risk: 999999, window_ends_at: null });
    const running = makeChain({ chain_id: "running", money_at_risk: 100, window_ends_at: inMinutes(600) });
    expect(rank([noWindow, running], NOW).map((c) => c.chain_id)).toEqual(["running", "no_window"]);
  });

  it("puts chains whose money is already safe last", () => {
    const done = makeChain({ chain_id: "done", money_at_risk: 500000, window_ends_at: inMinutes(5), state: "reversed" });
    const kept = makeChain({ chain_id: "kept", money_at_risk: 500000, window_ends_at: inMinutes(5), state: "kept" });
    const active = makeChain({ chain_id: "active", money_at_risk: 100, window_ends_at: inMinutes(600), state: "undoing" });
    const ranked = rank([done, kept, active], NOW).map((c) => c.chain_id);
    expect(ranked[0]).toBe("active");
    expect(ranked.slice(1).sort()).toEqual(["done", "kept"]);
  });

  it("breaks ties by chain id", () => {
    const a = makeChain({ chain_id: "chain_a", money_at_risk: 1000, window_ends_at: inMinutes(60) });
    const b = makeChain({ chain_id: "chain_b", money_at_risk: 1000, window_ends_at: inMinutes(60) });
    expect(rank([b, a], NOW).map((c) => c.chain_id)).toEqual(["chain_a", "chain_b"]);
  });

  it("does not mutate its input", () => {
    const first = makeChain({ chain_id: "first", money_at_risk: 1, window_ends_at: inMinutes(600) });
    const second = makeChain({ chain_id: "second", money_at_risk: 99999, window_ends_at: inMinutes(60) });
    const input = [first, second];
    rank(input, NOW);
    expect(input.map((c) => c.chain_id)).toEqual(["first", "second"]);
  });

  it("returns an empty list for an empty queue", () => {
    expect(rank([], NOW)).toEqual([]);
  });
});
