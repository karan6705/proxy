// Writes evals/RESULTS.md from the newest raw result files, so every number in it comes from a real run and cannot
// drift from the logs.   npx tsx evals/report.ts
//
// Counts only, never percentages. The caveat line is the same one the scoreboard page shows.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, "results");
export const RESULTS_MD = join(HERE, "RESULTS.md");

export const CAVEAT =
  "Counts from actual runs, not rates. Layer 1 is scripted: its naive column is a scripted self-review, not a measured miss rate. " +
  "Layer 2 is a live model on a small set of faulty tasks, with separate runs per arm. " +
  "Refunds are amounts the merchants agreed; Stripe verification and time to alert are not measured unless a row says so. " +
  "Merchants and the clock are our own simulations.";

interface Layer1Summary {
  arm: "naive" | "proxy";
  scenarios: number;
  passed: number;
  mistakes_expected: number;
  mistakes_caught: number;
  known_misses: number;
  false_alarms: number;
  known_false_alarms: number;
  chain_members_expected: number;
  chain_members_found: number;
  outcomes_expected: number;
  outcomes_correct: number;
  refund_agreed: number;
  refund_expected: number;
  false_done_claims: number;
}

export interface Layer1Results {
  run_id: string;
  not_measured?: { name: string; why: string }[];
  summaries: Layer1Summary[];
}

export interface Episode {
  task_id: string;
  arm: "naive" | "proxy";
  truth: { booking: string; field: string }[];
  agent: { status: "done" | "problem" | "unclear"; usage: { input_tokens: number; output_tokens: number } };
  false_done_claim?: boolean;
  self_detected?: boolean;
  proxy?: { caught: number; false_alarms: unknown[]; agreed_refund_total: number };
}

export interface Layer2Results {
  run_id: string;
  model: string;
  /** How Proxy was run: in process, or over MCP against a server. Older logs do not say, and were in process. */
  mode?: "in_process" | "mcp";
  mcp_url_host?: string;
  summary: {
    trials_per_task_arm: number;
    naive: { episodes: number; episodes_with_real_mistakes: number; self_detected: number; false_done_claims: number; tokens: number };
    proxy: { episodes: number; episodes_with_real_mistakes: number; mistakes: number; caught: number; false_alarms: number; refund_agreed: number; stripe_verified_actions?: number; tokens: number };
  };
  episodes: Episode[];
}

export interface TaskCounts {
  task_id: string;
  episodes_per_arm: number;
  naive_with_mistake: number;
  naive_noticed: number;
  naive_false_done: number;
  proxy_with_mistake: number;
  proxy_mistakes: number;
  proxy_caught: number;
  proxy_false_alarms: number;
  proxy_refund_agreed: number;
}

/** Per task counts, computed from the raw episodes. */
export function layer2ByTask(episodes: Episode[]): TaskCounts[] {
  const ids = [...new Set(episodes.map((item) => item.task_id))];
  return ids.map((task_id) => {
    const naive = episodes.filter((item) => item.task_id === task_id && item.arm === "naive");
    const proxy = episodes.filter((item) => item.task_id === task_id && item.arm === "proxy");
    const sum = (items: Episode[], pick: (item: Episode) => number): number => items.reduce((total, item) => total + pick(item), 0);
    return {
      task_id,
      episodes_per_arm: Math.max(naive.length, proxy.length),
      naive_with_mistake: naive.filter((item) => item.truth.length > 0).length,
      naive_noticed: sum(naive, (item) => (item.self_detected ? 1 : 0)),
      naive_false_done: sum(naive, (item) => (item.false_done_claim ? 1 : 0)),
      proxy_with_mistake: proxy.filter((item) => item.truth.length > 0).length,
      proxy_mistakes: sum(proxy, (item) => item.truth.length),
      proxy_caught: sum(proxy, (item) => item.proxy?.caught ?? 0),
      proxy_false_alarms: sum(proxy, (item) => item.proxy?.false_alarms.length ?? 0),
      proxy_refund_agreed: sum(proxy, (item) => item.proxy?.agreed_refund_total ?? 0),
    };
  });
}

/** Tasks where the agent misreads the request itself (C*) versus tasks where execution goes wrong (L*). */
export const isComprehensionTask = (taskId: string): boolean => taskId.startsWith("C");

export const TASK_TITLES: Record<string, string> = {
  L1: "monthly plan, signup form defaults to annual",
  L2: "flight call times out although it went through",
  L3: "espresso machine out of stock, a drip maker is offered",
  L4: "cheap hotel sells out, the only one left breaks the budget",
  L5: "clean trip, nothing goes wrong (control)",
  C1: "chain: a stale calendar says Nov 3, an email says Nov 13",
  C2: "chain: 3/11 written the European way means 3 November",
};

const dollars = (cents: number): string => {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const outOf = (value: number, total: number): string => `${value} / ${total}`;

function latest<T>(prefix: string, dir: string): { data: T; file: string } | null {
  if (!existsSync(dir)) {
    return null;
  }
  const newest = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().at(-1);
  return newest ? { data: JSON.parse(readFileSync(join(dir, newest), "utf8")) as T, file: newest } : null;
}

export function renderResults(layer1: { data: Layer1Results; file: string } | null, layer2: { data: Layer2Results; file: string } | null): string {
  const out: string[] = [];
  out.push("# Results", "");
  out.push("Generated by `npx tsx evals/report.ts` from the newest raw logs in `evals/results/`. Do not edit by hand: rerun the script.", "");
  out.push(`> ${CAVEAT}`, "");

  out.push("## Layer 1: scripted scenarios", "");
  if (!layer1) {
    out.push("No Layer 1 results yet. Run `npx tsx evals/run.ts`.", "");
  } else {
    const naive = layer1.data.summaries.find((item) => item.arm === "naive");
    const proxy = layer1.data.summaries.find((item) => item.arm === "proxy");
    out.push(`Raw log: [\`evals/results/${layer1.file}\`](results/${layer1.file}) (run \`${layer1.data.run_id}\`).`, "");
    if (naive && proxy) {
      out.push("| | Naive (scripted self-review) | Proxy |", "|---|---|---|");
      out.push(`| Scenarios passed | ${outOf(naive.passed, naive.scenarios)} | ${outOf(proxy.passed, proxy.scenarios)} |`);
      out.push(`| Real mistakes caught | ${outOf(naive.mistakes_caught, naive.mistakes_expected)} | ${outOf(proxy.mistakes_caught, proxy.mistakes_expected)} |`);
      out.push(`| of which documented known misses | ${naive.known_misses} | ${proxy.known_misses} |`);
      out.push(`| False alarms (including documented) | ${naive.false_alarms} | ${proxy.false_alarms} |`);
      out.push(`| Chain members found | ${outOf(naive.chain_members_found, naive.chain_members_expected)} | ${outOf(proxy.chain_members_found, proxy.chain_members_expected)} |`);
      out.push(`| Undo outcomes correct | ${outOf(naive.outcomes_correct, naive.outcomes_expected)} | ${outOf(proxy.outcomes_correct, proxy.outcomes_expected)} |`);
      out.push(`| Refunds agreed by merchants | ${dollars(naive.refund_agreed)} of ${dollars(naive.refund_expected)} | ${dollars(proxy.refund_agreed)} of ${dollars(proxy.refund_expected)} |`);
      for (const metric of layer1.data.not_measured ?? []) {
        out.push(`| ${metric.name} | n/a | n/a |`);
      }
      out.push("");
    }
    out.push(
      "**How it was measured.** 34 scripted scenarios in `evals/scenarios.ts`, each with expected results written by hand from the story and the human's real request, not from what the logic outputs. " +
        "Bookings are seeded with times. Proxy runs the real `compare`, `trace`, `plan_undo` and `negotiate_step` against our own mock merchants (with real Reversal Protocol exchanges for the hotel) on a simulated clock. " +
        "The naive arm is a scripted self-review: what it notices follows each scenario's stated assumption, so its column is not a measured rate. " +
        "Known misses and known false alarms are documented per scenario and counted. Refunds are what the merchants agreed; they are not verified in Stripe here.",
      "",
    );
  }

  out.push("## Layer 2: a live model as the agent", "");
  if (!layer2) {
    out.push("No Layer 2 results yet. Run `npx tsx --env-file=.env evals/live/run.ts`.", "");
  } else {
    const { summary } = layer2.data;
    const tasks = layer2ByTask(layer2.data.episodes);
    const mode = layer2.data.mode === "mcp" ? `over MCP against ${layer2.data.mcp_url_host ?? "a server"}` : "in process (not over MCP)";
    out.push(`Raw log: [\`evals/results/${layer2.file}\`](results/${layer2.file}) (run \`${layer2.data.run_id}\`). Model: \`${layer2.data.model}\`. ${summary.trials_per_task_arm} trials per task and arm. Proxy ran ${mode}.`, "");
    out.push("| | Naive (agent checks its own work) | Proxy |", "|---|---|---|");
    out.push(`| Episodes with a real mistake | ${outOf(summary.naive.episodes_with_real_mistakes, summary.naive.episodes)} | ${outOf(summary.proxy.episodes_with_real_mistakes, summary.proxy.episodes)} |`);
    out.push(`| Mistakes noticed (naive: agent said PROBLEM) or caught (Proxy: flagged) | ${outOf(summary.naive.self_detected, summary.naive.episodes_with_real_mistakes)} | ${outOf(summary.proxy.caught, summary.proxy.mistakes)} |`);
    out.push(`| False "done" claims | ${summary.naive.false_done_claims} | n/a |`);
    out.push(`| False alarms | n/a | ${summary.proxy.false_alarms} |`);
    if (layer2.data.mode === "mcp") {
      out.push(`| Actions whose refund Stripe shows (the server's own verification) | n/a | ${summary.proxy.stripe_verified_actions ?? 0} |`);
    } else {
      out.push(`| Refunds agreed by merchants | n/a | ${dollars(summary.proxy.refund_agreed)} |`);
    }
    out.push(`| Agent tokens | ${summary.naive.tokens.toLocaleString("en-US")} | ${summary.proxy.tokens.toLocaleString("en-US")} |`);
    out.push("");

    out.push("Per task (counts out of the episodes per arm):", "");
    out.push("| Task | What goes wrong | Naive: episodes with a mistake / noticed / false done | Proxy: real mistakes / caught / false alarms |", "|---|---|---|---|");
    for (const task of tasks) {
      out.push(
        `| ${task.task_id} | ${TASK_TITLES[task.task_id] ?? ""} | ${task.naive_with_mistake} / ${task.naive_noticed} / ${task.naive_false_done} of ${task.episodes_per_arm} | ${task.proxy_mistakes} / ${task.proxy_caught} / ${task.proxy_false_alarms} (in ${task.proxy_with_mistake} of ${task.episodes_per_arm} episodes) |`,
      );
    }
    out.push("");

    const execution = tasks.filter((task) => !isComprehensionTask(task.task_id));
    const comprehension = tasks.filter((task) => isComprehensionTask(task.task_id));
    const total = (items: TaskCounts[], pick: (task: TaskCounts) => number): number => items.reduce((sum, task) => sum + pick(task), 0);
    out.push("**What the split shows.**", "");
    out.push(
      `- Execution errors (tasks ${execution.map((task) => task.task_id).join(", ")}: a retry, a default, a substitute, a fallback): Proxy caught ${outOf(total(execution, (task) => task.proxy_caught), total(execution, (task) => task.proxy_mistakes))} real mistakes.`,
    );
    if (comprehension.length > 0) {
      out.push(
        `- Comprehension errors (tasks ${comprehension.map((task) => task.task_id).join(", ")}: the agent misreads the request, so a wrong date flows into several bookings): Proxy caught ${outOf(total(comprehension, (task) => task.proxy_caught), total(comprehension, (task) => task.proxy_mistakes))}. ` +
          "In these runs the agent logged the same misreading in `log_intent`, so Proxy compared the receipts with a wrong intent. Proxy is only as good as the intent it is given. " +
          "This is the documented limit (scenario S34) observed with a live model, and the reason intent should also be captured from the human's own words.",
      );
    }
    out.push("");
    out.push(
      "**How it was measured.** A real model (the one above) is the agent in each task's environment: tools that time out after succeeding, a signup that defaults to annual billing, an out-of-stock product with a similar one offered, a hotel that sells out, a stale calendar next to a newer email, and an ambiguous date format. " +
        "Nothing scripts the agent's mistake. What counts as a real mistake is written by hand per task (`evals/live/tasks.ts`) and does not use `compare`. " +
        "Naive: the agent is told to check its own work and ends with STATUS: DONE or STATUS: PROBLEM; a false \"done\" is DONE with a real mistake in what it booked. " +
        "Proxy: the agent calls `log_intent` first; Proxy then reviews every booking, including ones the agent never saw succeed (a timeout that went through), and the human replies UNDO ALL. " +
        "The two arms are separate live runs, so their mistake counts differ. Small samples.",
      "",
    );
  }

  out.push("## What we do not claim", "");
  out.push(
    "- No rates and no percentages. These are counts from small runs.",
    "- Layer 1's naive column is a scripted assumption, not a measurement. Layer 2's naive column is a live self-check by a small, cheap model; a stronger model may notice more.",
    "- Refund amounts are what merchants agreed. Verification against Stripe, and time to alert, are not measured in these runs unless a row says so.",
    "- Merchants, merchant agents and the clock are our own simulations.",
    "",
  );
  return `${out.join("\n")}\n`;
}

export function renderLatestResults(dir: string = RESULTS_DIR): string {
  return renderResults(latest<Layer1Results>("layer1-", dir), latest<Layer2Results>("layer2-", dir));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(RESULTS_MD, renderLatestResults());
  console.log(`Wrote ${RESULTS_MD}`);
}
