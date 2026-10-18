// Layer 1 (scripted) eval: runs every scenario against both arms, grades it, saves the raw log, prints a table.
//
//   npx tsx evals/run.ts
//
// Raw logs go to evals/results/<run id>.json: every result and grade, untouched. Report only numbers from a real run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeRun, summarize } from "./grader.js";
import { runScenario } from "./runner.js";
import type { Arm, Grade, RunResult } from "./scenario.js";
import { SCENARIOS } from "./scenarios.js";

const ARMS: Arm[] = ["naive", "proxy"];
/** Metrics Layer 1 cannot measure. They are shown as n/a, never as a number. */
const NOT_MEASURED = [
  { name: "time to alert", why: "Layer 1 has no live clock or channel; measured in Layer 2" },
  { name: "token cost", why: "Layer 1 makes no model calls; measured in Layer 2" },
  { name: "money Stripe-verified", why: "Layer 1 shows merchant-agreed amounts; Stripe verification is the orchestrator's" },
  { name: "redo correctness", why: "needs the live agent to redo the task; measured in Layer 2" },
] as const;

const NOTE =
  "Layer 1 is scripted. The 'naive' arm is a SCRIPTED SELF-REVIEW: the agent checks its own work, and what it notices " +
  "follows each scenario's stated assumption, so it is not a measured rate. What a real agent notices comes from the " +
  "live-agent layer. Mistakes counted include documented known misses, and false alarms include documented known false " +
  "alarms. Refunds are the amounts the merchants agreed; the orchestrator issues and verifies them through Stripe, " +
  "which this layer does not.";

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const pad = (text: string, width: number): string => text.padEnd(width);

export async function runAll(): Promise<{ results: RunResult[]; grades: Grade[] }> {
  const results: RunResult[] = [];
  const grades: Grade[] = [];
  for (const scenario of SCENARIOS) {
    for (const arm of ARMS) {
      const result = await runScenario(scenario, arm);
      results.push(result);
      grades.push(gradeRun(scenario, result));
    }
  }
  return { results, grades };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { results, grades } = await runAll();
  const summaries = ARMS.map((arm) => summarize(arm, grades));

  const runId = `layer1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.json`);
  writeFileSync(file, `${JSON.stringify({ run_id: runId, layer: "scripted", note: NOTE, not_measured: NOT_MEASURED, summaries, grades, results }, null, 2)}\n`);

  console.log(`\n${runId}  (${SCENARIOS.length} scenarios x ${ARMS.length} arms)\n`);
  console.log(`${pad("scenario", 38)}${pad("naive", 8)}${pad("proxy", 8)}`);
  for (const scenario of SCENARIOS) {
    const cell = (arm: Arm): string => (grades.find((g) => g.scenario_id === scenario.id && g.arm === arm)?.passed ? "pass" : "FAIL");
    console.log(`${pad(`${scenario.id} ${scenario.title}`.slice(0, 36), 38)}${pad(cell("naive"), 8)}${pad(cell("proxy"), 8)}`);
  }

  console.log(`\n${pad("", 30)}${pad("naive (scripted)", 18)}${pad("proxy", 18)}`);
  const [naive, proxy] = summaries;
  const row = (label: string, a: string, b: string): void => console.log(`${pad(label, 30)}${pad(a, 18)}${pad(b, 18)}`);
  row("scenarios passed", `${naive.passed}/${naive.scenarios}`, `${proxy.passed}/${proxy.scenarios}`);
  row("mistakes caught", `${naive.mistakes_caught}/${naive.mistakes_expected}`, `${proxy.mistakes_caught}/${proxy.mistakes_expected}`);
  row("  of which known misses", String(naive.known_misses), String(proxy.known_misses));
  row("false alarms", String(naive.false_alarms), String(proxy.false_alarms));
  row("  of which documented", String(naive.known_false_alarms), String(proxy.known_false_alarms));
  row("chain members found", `${naive.chain_members_found}/${naive.chain_members_expected}`, `${proxy.chain_members_found}/${proxy.chain_members_expected}`);
  row("undo outcomes correct", `${naive.outcomes_correct}/${naive.outcomes_expected}`, `${proxy.outcomes_correct}/${proxy.outcomes_expected}`);
  row("refund agreed / expected", `${dollars(naive.refund_agreed)}/${dollars(naive.refund_expected)}`, `${dollars(proxy.refund_agreed)}/${dollars(proxy.refund_expected)}`);
  row("false 'done' claims", String(naive.false_done_claims), String(proxy.false_done_claims));
  for (const metric of NOT_MEASURED) {
    row(metric.name, "n/a", "n/a");
  }
  console.log(`\n${NOTE}\n\nRaw log: ${file}`);
}
