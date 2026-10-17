import { describe, expect, it } from "vitest";
import { gradeRun, summarize } from "../../evals/grader.js";
import { runScenario } from "../../evals/runner.js";
import { runAll } from "../../evals/run.js";
import type { RunResult, Scenario } from "../../evals/scenario.js";
import { SCENARIOS } from "../../evals/scenarios.js";

const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id) as Scenario;

describe("scenarios", () => {
  it("have unique ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only expect results for bookings they actually make", () => {
    for (const s of SCENARIOS) {
      const ids = new Set(s.bookings.map((b) => b.id));
      expect(ids.size, `${s.id} has duplicate booking ids`).toBe(s.bookings.length);
      for (const m of s.expect.mismatches) expect(ids.has(m.action), `${s.id} mismatch ${m.action}`).toBe(true);
      for (const c of s.expect.chains) for (const a of [...c.actions, c.root]) expect(ids.has(a), `${s.id} chain ${a}`).toBe(true);
      for (const id of Object.keys(s.expect.outcomes ?? {})) expect(ids.has(id), `${s.id} outcome ${id}`).toBe(true);
    }
  });

  it("each say why the naive arm sees what it sees", () => {
    for (const s of SCENARIOS) expect(s.assumption.length, s.id).toBeGreaterThan(20);
  });
});

describe("the proxy arm", () => {
  it("passes every scenario", async () => {
    for (const s of SCENARIOS) {
      const grade = gradeRun(s, await runScenario(s, "proxy"));
      expect(grade, s.id).toMatchObject({ passed: true, arm: "proxy" });
    }
  });

  it("S01: runs the demo end to end, with the hotel negotiated in three rounds", async () => {
    const result = await runScenario(scenario("S01"), "proxy");
    expect(result.alert_sent).toBe(true);
    expect(result.chains).toEqual([{ actions: ["flight", "transfer", "host_email", "hotel"], root: "flight", money_at_risk: 124000 }]);
    expect(result.outcomes).toEqual({ flight: "refund_agreed", transfer: "refund_agreed", host_email: "corrected", hotel: "refund_agreed" });
    expect(result.agreed_refund_total).toBe(41200 + 54400 + 18800);
    expect(result.negotiation_rounds).toEqual({ hotel: 3 });
    const log = result.transcript.join("\n");
    expect(log).toContain("hotel: Proxy request_reversal -> merchant counter store_credit 64000");
    expect(log).toContain("hotel: Proxy push_back -> merchant counter partial_refund 54400");
    expect(log).toContain("hotel: Proxy accept_counter -> merchant accept 54400");
  });

  it("S02: KEEP leaves everything alone and agrees no refund", async () => {
    const result = await runScenario(scenario("S02"), "proxy");
    expect(result.outcomes).toEqual({ flight: "kept" });
    expect(result.agreed_refund_total).toBe(0);
    expect(result.transcript.join("\n")).not.toContain("self-serve");
  });

  it("S13: flags only the retried booking and refunds only that one", async () => {
    const result = await runScenario(scenario("S13"), "proxy");
    expect(result.mismatches).toEqual([{ action: "flight_retry", field: "duplicate" }]);
    expect(Object.keys(result.outcomes)).toEqual(["flight_retry"]);
    expect(result.agreed_refund_total).toBe(41200);
  });

  it("S27 and S28: a correct trip raises no alarm, even with a late confirmation", async () => {
    for (const id of ["S27", "S28"]) {
      const result = await runScenario(scenario(id), "proxy");
      expect(result, id).toMatchObject({ mismatches: [], chains: [], alert_sent: false, agreed_refund_total: 0 });
    }
  });

  it("gives the same answer twice", async () => {
    const first = await runScenario(scenario("S01"), "proxy");
    const second = await runScenario(scenario("S01"), "proxy");
    expect(second).toEqual(first);
  });
});

describe("the naive arm (the agent checking its own work)", () => {
  it("S01: finds nothing, says it is done, and so makes a false done claim", async () => {
    const s = scenario("S01");
    const result = await runScenario(s, "naive");
    expect(result).toMatchObject({ mismatches: [], chains: [], alert_sent: false, claims_done: true, agreed_refund_total: 0 });
    expect(gradeRun(s, result)).toMatchObject({ passed: false, false_done_claim: true, mistakes: { expected: 4, caught: 0 } });
  });

  it("S13: misses the duplicate because it never saw the first booking succeed", async () => {
    const result = await runScenario(scenario("S13"), "naive");
    expect(result.mismatches).toEqual([]);
  });

  it("notices a problem when its own view shows one, but still cannot trace or undo it", async () => {
    const aware: Scenario = { ...scenario("S01"), agent_belief: undefined, assumption: "The agent knew the right dates and made a typo." };
    const result = await runScenario(aware, "naive");
    expect(result.mismatches.length).toBe(4);
    expect(result.claims_done).toBe(false);
    expect(result.chains).toEqual([]);
    expect(result.outcomes).toEqual({});
  });

  it("is not penalized on a correct trip: nothing to catch, so no false done claim", async () => {
    const s = scenario("S27");
    const grade = gradeRun(s, await runScenario(s, "naive"));
    expect(grade).toMatchObject({ passed: true, false_done_claim: false });
  });
});

describe("the grader fails when something is wrong", () => {
  async function proxyS01(): Promise<{ s: Scenario; result: RunResult }> {
    const s = scenario("S01");
    return { s, result: await runScenario(s, "proxy") };
  }

  it("flags a missed mistake", async () => {
    const { s, result } = await proxyS01();
    const grade = gradeRun(s, { ...result, mismatches: result.mismatches.filter((m) => m.action !== "hotel") });
    expect(grade.passed).toBe(false);
    expect(grade.mistakes.missed).toEqual(["hotel:dates"]);
  });

  it("flags a false alarm", async () => {
    const { s, result } = await proxyS01();
    const grade = gradeRun(s, { ...result, mismatches: [...result.mismatches, { action: "flight", field: "amount" }] });
    expect(grade.passed).toBe(false);
    expect(grade.mistakes.false_alarms).toEqual(["flight:amount"]);
  });

  it("flags a wrong undo outcome", async () => {
    const { s, result } = await proxyS01();
    const grade = gradeRun(s, { ...result, outcomes: { ...result.outcomes, hotel: "not_undone" } });
    expect(grade.passed).toBe(false);
    expect(grade.outcomes.wrong).toEqual(["hotel: expected refund_agreed, got not_undone"]);
  });

  it("flags a wrong refund total", async () => {
    const { s, result } = await proxyS01();
    const grade = gradeRun(s, { ...result, agreed_refund_total: result.agreed_refund_total - 1 });
    expect(grade.passed).toBe(false);
    expect(grade.agreed_refund.correct).toBe(false);
  });

  it("flags a chain with the wrong root, wrong money or a missing member", async () => {
    const { s, result } = await proxyS01();
    const chain = result.chains[0];
    expect(gradeRun(s, { ...result, chains: [{ ...chain, root: "hotel" }] }).chains.all_correct).toBe(false);
    expect(gradeRun(s, { ...result, chains: [{ ...chain, money_at_risk: 1 }] }).chains.all_correct).toBe(false);
    const short = gradeRun(s, { ...result, chains: [{ ...chain, actions: chain.actions.slice(1) }] });
    expect(short.chains.all_correct).toBe(false);
    expect(short.chains.found_members).toBe(3);
  });

  it("flags a missing or unexpected alert", async () => {
    const { s, result } = await proxyS01();
    expect(gradeRun(s, { ...result, alert_sent: false })).toMatchObject({ alert_correct: false, passed: false });
    const clean = scenario("S27");
    const cleanResult = await runScenario(clean, "proxy");
    expect(gradeRun(clean, { ...cleanResult, alert_sent: true })).toMatchObject({ alert_correct: false, passed: false });
  });
});

describe("runAll and summarize", () => {
  it("runs every scenario against both arms", async () => {
    const { results, grades } = await runAll();
    expect(results).toHaveLength(SCENARIOS.length * 2);
    expect(grades).toHaveLength(SCENARIOS.length * 2);
  });

  it("summarizes each arm", async () => {
    const { grades } = await runAll();
    const naive = summarize("naive", grades);
    const proxy = summarize("proxy", grades);
    expect(proxy).toMatchObject({ scenarios: 5, passed: 5, mistakes_expected: 6, mistakes_caught: 6, false_alarms: 0, false_done_claims: 0 });
    expect(naive).toMatchObject({ scenarios: 5, passed: 2, mistakes_expected: 6, mistakes_caught: 0, false_alarms: 0, false_done_claims: 3 });
    expect(proxy.refund_agreed).toBe(proxy.refund_expected);
    expect(naive.refund_agreed).toBe(0);
  });
});
