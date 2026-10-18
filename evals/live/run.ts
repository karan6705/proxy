// Layer 2: a real model is the agent. Run with:  npx tsx --env-file=.env evals/live/run.ts
//   LIVE_TRIALS=3        trials per task and arm (default 3)
//   LIVE_TASKS=L1,L2     only these tasks
//   LIVE_EVAL_MODEL=...  the agent's model (default claude-haiku-4-5-20251001)
//
// For each task and arm the agent runs against the task's faulty environment. Then:
//   truth       hand-written per task, not computed by compare: what was really wrong.
//   naive arm   the agent checks its own work and says DONE or PROBLEM. A false "done" claim is DONE with real mistakes.
//   proxy arm   the agent logs its intent, then Proxy (real compare, trace, plan_undo and negotiation, in process,
//               against the mock merchants) reviews every booking, including ones the agent never saw succeed, and
//               undoes the chain after UNDO ALL. Money is what the merchants agreed, not Stripe-verified.
// Small samples: these are counts from real runs, not rates. The key is read from the environment and never printed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arm } from "../../src/types.js";
import type { RunResult, Scenario } from "../scenario.js";
import { runScenario } from "../runner.js";
import type { SimBooking } from "../sim.js";
import type { AgentRun } from "./agent.js";
import { AGENT_MODEL, runAgent } from "./agent.js";
import { LIVE_TASKS, type LiveTask } from "./tasks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIALS = Math.max(1, Number(process.env.LIVE_TRIALS ?? 3) || 3);
const ONLY = (process.env.LIVE_TASKS ?? "").split(",").map((id) => id.trim()).filter(Boolean);

interface Episode {
  task_id: string;
  arm: Arm;
  trial: number;
  agent: AgentRun;
  bookings: number;
  /** Real mistakes in what was booked, by hand-written truth. */
  truth: { booking: string; field: string }[];
  /** Proxy arm only. */
  proxy?: {
    flagged: { action: string; field: string }[];
    caught: number;
    missed: { booking: string; field: string }[];
    false_alarms: { action: string; field: string }[];
    outcomes: RunResult["outcomes"];
    agreed_refund_total: number;
  };
  /** Naive arm only: the agent said DONE although the truth has mistakes. */
  false_done_claim?: boolean;
  /** Naive arm only: the agent said PROBLEM and there was one. */
  self_detected?: boolean;
}

function liveScenario(task: LiveTask, agent: AgentRun, bookings: SimBooking[], unseen: string[]): Scenario {
  const last = bookings.reduce((latest, booking) => Math.max(latest, Date.parse(booking.booked_at)), 0);
  return {
    id: `live-${task.id}`,
    title: task.title,
    group: "live",
    intent: task.intent,
    logged_intent: agent.logged_intent ?? { goal: "", constraints: {} },
    assumption: "Layer 2: the bookings come from a live model.",
    bookings,
    unseen_by_agent: unseen,
    now: new Date(last + 3 * 60 * 60_000).toISOString(),
    human_reply: "UNDO ALL",
    expect: { mismatches: [], chains: [], alert: false },
  };
}

async function episode(task: LiveTask, arm: Arm, trial: number): Promise<Episode> {
  const env = task.env();
  const agent = await runAgent(task, env, arm);
  const bookings = env.bookings();
  const truth = task.truth(bookings);
  const base: Episode = { task_id: task.id, arm, trial, agent, bookings: bookings.length, truth };

  if (arm === "naive") {
    return {
      ...base,
      false_done_claim: agent.status !== "problem" && truth.length > 0,
      self_detected: agent.status === "problem" && truth.length > 0,
    };
  }

  if (bookings.length === 0) {
    return { ...base, proxy: { flagged: [], caught: 0, missed: truth, false_alarms: [], outcomes: {}, agreed_refund_total: 0 } };
  }
  const result = await runScenario(liveScenario(task, agent, bookings, env.unseen()), "proxy");
  const flagged = result.mismatches;
  const key = (booking: string, field: string): string => `${booking}:${field}`;
  const truthKeys = new Set(truth.map((item) => key(item.booking, item.field)));
  const flaggedKeys = new Set(flagged.map((item) => key(item.action, item.field)));
  return {
    ...base,
    proxy: {
      flagged,
      caught: truth.filter((item) => flaggedKeys.has(key(item.booking, item.field))).length,
      missed: truth.filter((item) => !flaggedKeys.has(key(item.booking, item.field))),
      false_alarms: flagged.filter((item) => !truthKeys.has(key(item.action, item.field))),
      outcomes: result.outcomes,
      agreed_refund_total: result.agreed_refund_total,
    },
  };
}

const ratio = (numerator: number, denominator: number): string => (denominator === 0 ? "n/a" : `${numerator}/${denominator}`);
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const redact = (text: string): string => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env and run: npx tsx --env-file=.env evals/live/run.ts");
    process.exit(1);
  }
  const tasks = LIVE_TASKS.filter((task) => ONLY.length === 0 || ONLY.includes(task.id));
  const runId = `layer2-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const episodes: Episode[] = [];
  console.log(`\n${runId}  model ${AGENT_MODEL}  ${tasks.length} tasks x 2 arms x ${TRIALS} trials\n`);

  for (const task of tasks) {
    for (const arm of ["naive", "proxy"] as const) {
      for (let trial = 1; trial <= TRIALS; trial += 1) {
        try {
          const result = await episode(task, arm, trial);
          episodes.push(result);
          const note = arm === "naive" ? `says ${result.agent.status}` : `flagged ${result.proxy?.flagged.length ?? 0}`;
          console.log(`${task.id} ${arm.padEnd(5)} #${trial}  bookings ${result.bookings}  real mistakes ${result.truth.length}  ${note}`);
        } catch (error) {
          // A failed episode is reported, never dropped from the output silently.
          console.error(`${task.id} ${arm} #${trial} FAILED: ${redact(error instanceof Error ? error.message : String(error))}`);
        }
      }
    }
  }

  const naive = episodes.filter((item) => item.arm === "naive");
  const proxy = episodes.filter((item) => item.arm === "proxy");
  const sum = (items: Episode[], pick: (item: Episode) => number): number => items.reduce((total, item) => total + pick(item), 0);
  const tokens = (items: Episode[]): number => sum(items, (item) => item.agent.usage.input_tokens + item.agent.usage.output_tokens);
  const summary = {
    model: AGENT_MODEL,
    trials_per_task_arm: TRIALS,
    naive: {
      episodes: naive.length,
      episodes_with_real_mistakes: naive.filter((item) => item.truth.length > 0).length,
      self_detected: sum(naive, (item) => (item.self_detected ? 1 : 0)),
      false_done_claims: sum(naive, (item) => (item.false_done_claim ? 1 : 0)),
      tokens: tokens(naive),
    },
    proxy: {
      episodes: proxy.length,
      episodes_with_real_mistakes: proxy.filter((item) => item.truth.length > 0).length,
      mistakes: sum(proxy, (item) => item.truth.length),
      caught: sum(proxy, (item) => item.proxy?.caught ?? 0),
      false_alarms: sum(proxy, (item) => item.proxy?.false_alarms.length ?? 0),
      refund_agreed: sum(proxy, (item) => item.proxy?.agreed_refund_total ?? 0),
      tokens: tokens(proxy),
    },
  };

  console.log("\nnaive (agent checks its own work)");
  console.log(`  episodes with a real mistake   ${summary.naive.episodes_with_real_mistakes}/${summary.naive.episodes}`);
  console.log(`  agent noticed (said PROBLEM)   ${ratio(summary.naive.self_detected, summary.naive.episodes_with_real_mistakes)}`);
  console.log(`  false 'done' claims            ${summary.naive.false_done_claims}`);
  console.log(`  tokens                         ${summary.naive.tokens}`);
  console.log("proxy");
  console.log(`  episodes with a real mistake   ${summary.proxy.episodes_with_real_mistakes}/${summary.proxy.episodes}`);
  console.log(`  mistakes caught                ${ratio(summary.proxy.caught, summary.proxy.mistakes)}`);
  console.log(`  false alarms                   ${summary.proxy.false_alarms}`);
  console.log(`  refunds agreed                 ${dollars(summary.proxy.refund_agreed)}  (merchant-agreed, not Stripe-verified)`);
  console.log(`  tokens (agent only)            ${summary.proxy.tokens}`);
  console.log(
    "\nSmall samples from real runs: counts, not rates. The agent's mistakes come from a live model in a faulty environment; " +
      "truth is hand-written per task. Proxy ran in process, not over MCP. Time to alert and Stripe verification are not measured here.",
  );

  const dir = join(HERE, "..", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.json`);
  writeFileSync(file, `${JSON.stringify({ run_id: runId, layer: "live-agent", model: AGENT_MODEL, summary, episodes }, null, 2)}\n`);
  console.log(`\nRaw log: ${file}`);
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
