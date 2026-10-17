// The grader: compares what a run did with what the scenario says should happen.
// Expected results are written by hand in the scenario, so this does not share compare/trace's blind spots.

import type { Arm, ExpectedChain, FoundChain, Grade, Outcome, RunResult, Scenario } from "./scenario.js";

const keyOf = (m: { action: string; field: string }): string => `${m.action}:${m.field}`;
const sameMembers = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function overlap(a: string[], b: string[]): number {
  const set = new Set(b);
  return a.filter((x) => set.has(x)).length;
}

/** The found chain that shares the most members with an expected one. */
function bestMatch(expected: ExpectedChain, found: FoundChain[]): FoundChain | null {
  let best: FoundChain | null = null;
  let bestScore = 0;
  for (const chain of found) {
    const score = overlap(expected.actions, chain.actions);
    if (score > bestScore) {
      best = chain;
      bestScore = score;
    }
  }
  return best;
}

export function gradeRun(scenario: Scenario, result: RunResult): Grade {
  const { expect } = scenario;

  const expectedKeys = new Set(expect.mismatches.map(keyOf));
  const foundKeys = new Set(result.mismatches.map(keyOf));
  const missed = [...expectedKeys].filter((k) => !foundKeys.has(k));
  const falseAlarms = [...foundKeys].filter((k) => !expectedKeys.has(k));

  let foundMembers = 0;
  let chainsAllCorrect = result.chains.length === expect.chains.length;
  for (const expected of expect.chains) {
    const match = bestMatch(expected, result.chains);
    foundMembers += match ? overlap(expected.actions, match.actions) : 0;
    const exact = match !== null && sameMembers(expected.actions, match.actions) && match.root === expected.root && match.money_at_risk === expected.money_at_risk;
    chainsAllCorrect = chainsAllCorrect && exact;
  }

  const expectedOutcomes = Object.entries(expect.outcomes ?? {}) as [string, Outcome][];
  const wrongOutcomes = expectedOutcomes
    .filter(([id, outcome]) => (result.outcomes[id] ?? "none") !== outcome)
    .map(([id, outcome]) => `${id}: expected ${outcome}, got ${result.outcomes[id] ?? "none"}`);

  const expectedRefund = expect.agreed_refund_total ?? null;
  const refundCorrect = expectedRefund === null ? null : result.agreed_refund_total === expectedRefund;

  const alertCorrect = result.alert_sent === expect.alert;
  const falseDone = result.arm === "naive" && result.claims_done && expect.mismatches.length > 0;

  return {
    scenario_id: scenario.id,
    arm: result.arm,
    mistakes: { expected: expectedKeys.size, caught: expectedKeys.size - missed.length, missed, false_alarms: falseAlarms },
    chains: {
      expected: expect.chains.length,
      found: result.chains.length,
      expected_members: expect.chains.reduce((sum, c) => sum + c.actions.length, 0),
      found_members: foundMembers,
      all_correct: chainsAllCorrect,
    },
    alert_correct: alertCorrect,
    outcomes: { expected: expectedOutcomes.length, correct: expectedOutcomes.length - wrongOutcomes.length, wrong: wrongOutcomes },
    agreed_refund: { expected: expectedRefund, actual: result.agreed_refund_total, correct: refundCorrect },
    false_done_claim: falseDone,
    passed: missed.length === 0 && falseAlarms.length === 0 && chainsAllCorrect && alertCorrect && wrongOutcomes.length === 0 && refundCorrect !== false,
  };
}

export interface ArmSummary {
  arm: Arm;
  scenarios: number;
  passed: number;
  mistakes_expected: number;
  mistakes_caught: number;
  false_alarms: number;
  chain_members_expected: number;
  chain_members_found: number;
  outcomes_expected: number;
  outcomes_correct: number;
  /** Cents the merchants agreed to refund, against what the scenarios expect. */
  refund_agreed: number;
  refund_expected: number;
  false_done_claims: number;
}

export function summarize(arm: Arm, grades: Grade[]): ArmSummary {
  const mine = grades.filter((g) => g.arm === arm);
  const sum = (pick: (g: Grade) => number): number => mine.reduce((total, g) => total + pick(g), 0);
  return {
    arm,
    scenarios: mine.length,
    passed: mine.filter((g) => g.passed).length,
    mistakes_expected: sum((g) => g.mistakes.expected),
    mistakes_caught: sum((g) => g.mistakes.caught),
    false_alarms: sum((g) => g.mistakes.false_alarms.length),
    chain_members_expected: sum((g) => g.chains.expected_members),
    chain_members_found: sum((g) => g.chains.found_members),
    outcomes_expected: sum((g) => g.outcomes.expected),
    outcomes_correct: sum((g) => g.outcomes.correct),
    refund_agreed: sum((g) => g.agreed_refund.actual),
    refund_expected: sum((g) => g.agreed_refund.expected ?? 0),
    false_done_claims: mine.filter((g) => g.false_done_claim).length,
  };
}
