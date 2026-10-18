// The scoreboard page: one self-contained HTML file (no network, no scripts) styled as a dark 16:9 slide.
//
//   npx tsx evals/scoreboard.ts      writes evals/scoreboard/index.html from the latest Layer 1 and Layer 2 results
//
// Counts, never percentages. Every number comes from a results file written by an actual run. The caveat line is
// part of the page, not a footnote to remove. Karan's server can serve renderLatestScoreboard() at /scoreboard.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAVEAT, TASK_TITLES, isComprehensionTask, layer2ByTask, type Layer1Results, type Layer2Results } from "./report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, "results");
export const SCOREBOARD_FILE = join(HERE, "scoreboard", "index.html");

export type { Layer1Results, Layer2Results };

const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

const dollars = (cents: number): string => {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
};
/** The date part of a run id such as layer1-2026-10-17T23-22-35-970Z. */
const runDate = (runId: string): string => runId.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? runId;
const outOf = (value: number, total: number): string => `${value} / ${total}`;
const NA = "n/a";

interface Row {
  label: string;
  naive: string;
  proxy: string;
  /** A short second line under the label. */
  hint?: string;
}

function layer1Rows(results: Layer1Results): Row[] {
  const naive = results.summaries.find((item) => item.arm === "naive");
  const proxy = results.summaries.find((item) => item.arm === "proxy");
  if (!naive || !proxy) {
    return [];
  }
  const rows: Row[] = [
    { label: "Scenarios passed", naive: outOf(naive.passed, naive.scenarios), proxy: outOf(proxy.passed, proxy.scenarios) },
    {
      label: "Real mistakes caught",
      naive: outOf(naive.mistakes_caught, naive.mistakes_expected),
      proxy: outOf(proxy.mistakes_caught, proxy.mistakes_expected),
      hint: `${proxy.known_misses} are documented known misses`,
    },
    { label: "False alarms", naive: String(naive.false_alarms), proxy: String(proxy.false_alarms), hint: `${proxy.known_false_alarms} documented` },
    { label: "Chain members found", naive: outOf(naive.chain_members_found, naive.chain_members_expected), proxy: outOf(proxy.chain_members_found, proxy.chain_members_expected) },
    { label: "Undo outcomes correct", naive: outOf(naive.outcomes_correct, naive.outcomes_expected), proxy: outOf(proxy.outcomes_correct, proxy.outcomes_expected) },
    {
      label: "Refunds agreed",
      naive: `${dollars(naive.refund_agreed)} / ${dollars(naive.refund_expected)}`,
      proxy: `${dollars(proxy.refund_agreed)} / ${dollars(proxy.refund_expected)}`,
      hint: "merchant-agreed, not Stripe-verified",
    },
  ];
  return rows;
}

/** The metrics this layer cannot measure, listed explicitly as n/a so nothing is implied. */
function notMeasured(results: Layer1Results): string {
  return (results.not_measured ?? []).map((metric) => metric.name).join(" · ");
}

function layer2Rows(results: Layer2Results): Row[] {
  const { naive, proxy } = results.summary;
  return [
    { label: "Episodes with a real mistake", naive: outOf(naive.episodes_with_real_mistakes, naive.episodes), proxy: outOf(proxy.episodes_with_real_mistakes, proxy.episodes) },
    { label: "Mistakes noticed or caught", naive: outOf(naive.self_detected, naive.episodes_with_real_mistakes), proxy: outOf(proxy.caught, proxy.mistakes), hint: "agent said PROBLEM / Proxy flagged" },
    { label: "False “done” claims · false alarms", naive: String(naive.false_done_claims), proxy: `${proxy.false_alarms} false alarms` },
  ];
}

/** One line of the rest: money and tokens. */
function layer2Footer(results: Layer2Results): string {
  const { naive, proxy } = results.summary;
  const money =
    results.mode === "mcp"
      ? `Refunds Stripe shows: ${proxy.stripe_verified_actions ?? 0} actions`
      : `Refunds agreed: ${dollars(proxy.refund_agreed)} (merchant-agreed)`;
  return `<p class="nalist">${escapeHtml(money)} · Tokens ${naive.tokens.toLocaleString("en-US")} / ${proxy.tokens.toLocaleString("en-US")}</p>`;
}

const SHORT_TITLES: Record<string, string> = {
  L1: "signup defaults to annual",
  L2: "call times out, then retried",
  L3: "out of stock, substitute offered",
  L4: "hotel sells out, over budget",
  L5: "clean trip (control)",
  C1: "chain: stale calendar date",
  C2: "chain: 3/11 read as March",
};

/** Per task counts for the live agent, plus the execution versus comprehension split. */
function taskBlock(results: Layer2Results): string {
  const tasks = layer2ByTask(results.episodes ?? []);
  if (tasks.length === 0) {
    return "";
  }
  const rows = tasks
    .map(
      (task) => `<tr><th scope="row">${escapeHtml(task.task_id)} <span>${escapeHtml(SHORT_TITLES[task.task_id] ?? TASK_TITLES[task.task_id] ?? "")}</span></th>
        <td>${task.naive_false_done} / ${task.episodes_per_arm}</td>
        <td class="proxy">${task.proxy_caught} / ${task.proxy_mistakes}</td></tr>`,
    )
    .join("");
  const total = (items: typeof tasks, pick: (task: (typeof tasks)[number]) => number): number => items.reduce((sum, task) => sum + pick(task), 0);
  const execution = tasks.filter((task) => !isComprehensionTask(task.task_id));
  const comprehension = tasks.filter((task) => isComprehensionTask(task.task_id));
  const split =
    comprehension.length > 0
      ? `<p class="nalist"><b>Execution errors</b> (retry, default, substitute, fallback): Proxy caught ${total(execution, (task) => task.proxy_caught)} / ${total(execution, (task) => task.proxy_mistakes)}. ` +
        `<b>Comprehension errors</b> (agent misreads the request, then logs the same misreading): ${total(comprehension, (task) => task.proxy_caught)} / ${total(comprehension, (task) => task.proxy_mistakes)}.</p>`
      : "";
  return `<table class="tasks"><thead><tr><th>Per task</th><th>Naive false “done”</th><th class="proxy">Proxy caught / real</th></tr></thead><tbody>${rows}</tbody></table>${split}`;
}

function table(rows: Row[], naiveLabel: string, na: string, showNa = true): string {
  const body = rows
    .map(
      (row) => `<tr>
        <th scope="row">${escapeHtml(row.label)}${row.hint ? `<small>${escapeHtml(row.hint)}</small>` : ""}</th>
        <td class="${row.naive === NA ? "na" : ""}">${escapeHtml(row.naive)}</td>
        <td class="proxy ${row.proxy === NA ? "na" : ""}">${escapeHtml(row.proxy)}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th></th><th>${escapeHtml(naiveLabel)}</th><th class="proxy">Proxy</th></tr></thead><tbody>${body}</tbody></table>${showNa ? `<p class="nalist"><b>n/a here:</b> ${escapeHtml(na)}</p>` : ""}`;
}

const CSS = `
:root{--bg:#0a0c10;--panel:#12151c;--line:#232834;--text:#e8ebf2;--muted:#8a93a6;--accent:#5eead4;--warn:#fbbf24;--u:min(1vw,1.7778vh)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
body{display:grid;place-items:center;min-height:100vh}
.slide{width:calc(var(--u)*100);height:calc(var(--u)*56.25);padding:calc(var(--u)*2.4) calc(var(--u)*4);display:flex;flex-direction:column;gap:calc(var(--u)*1.2);overflow:hidden}
header{display:flex;align-items:baseline;justify-content:space-between}
h1{font-size:calc(var(--u)*3);margin:0;letter-spacing:-.02em}h1 span{color:var(--accent)}
.sub{color:var(--muted);font-size:calc(var(--u)*1.35)}
.grid{display:grid;grid-template-columns:.85fr 1.15fr;gap:calc(var(--u)*2);flex:1;min-height:0}
section{background:var(--panel);border:1px solid var(--line);border-radius:calc(var(--u)*1);padding:calc(var(--u)*1.6) calc(var(--u)*1.8);display:flex;flex-direction:column;min-height:0}
h2{margin:0 0 calc(var(--u)*.3);font-size:calc(var(--u)*1.8)}
.tag{color:var(--muted);font-size:calc(var(--u)*1);margin-bottom:calc(var(--u)*.8)}
table{width:100%;border-collapse:collapse;font-size:calc(var(--u)*1.25)}
thead th{color:var(--muted);font-weight:500;text-align:right;padding:0 0 calc(var(--u)*.6)}
thead th:first-child{text-align:left}
tbody th{text-align:left;font-weight:500;padding:calc(var(--u)*.5) 0;border-top:1px solid var(--line)}
tbody th small{display:block;color:var(--muted);font-weight:400;font-size:calc(var(--u)*.95)}
td{text-align:right;padding:calc(var(--u)*.5) 0 calc(var(--u)*.5) calc(var(--u)*1);border-top:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
thead th:not(:first-child){white-space:nowrap;padding-left:calc(var(--u)*1)}
.nalist{margin:calc(var(--u)*.9) 0 0;color:var(--muted);font-size:calc(var(--u)*1)}.nalist b{font-weight:600}
.proxy{color:var(--accent);font-weight:600}.na{color:var(--muted);font-weight:400}
.caveat{margin:0;color:var(--warn);font-size:calc(var(--u)*.95);line-height:1.4;border-top:1px solid var(--line);padding-top:calc(var(--u)*1)}
.tasks{margin-top:calc(var(--u)*.7);font-size:calc(var(--u)*1)}.tasks thead th{font-size:calc(var(--u)*.9)}.tasks tbody th{padding:calc(var(--u)*.16) 0;font-weight:600}.tasks tbody th span{font-weight:400;color:var(--muted)}.tasks td{padding:calc(var(--u)*.16) 0 calc(var(--u)*.16) calc(var(--u)*1)}
.empty{color:var(--muted);font-size:calc(var(--u)*1.3);margin:auto}
`;

export function renderScoreboard(layer1: Layer1Results | null, layer2: Layer2Results | null): string {
  const first = layer1
    ? `<h2>Scripted scenarios</h2><div class="tag">${escapeHtml(layer1.summaries[0]?.scenarios ?? 0)} scenarios · Layer 1 · scripted · ${escapeHtml(runDate(layer1.run_id))}</div>${table(layer1Rows(layer1), "Naive (scripted)", notMeasured(layer1))}`
    : `<h2>Scripted scenarios</h2><p class="empty">No Layer 1 results yet. Run: npx tsx evals/run.ts</p>`;
  const second = layer2
    ? `<h2>Live agent</h2><div class="tag">${escapeHtml(layer2.model)} · ${escapeHtml(layer2.summary.trials_per_task_arm)} trials per task and arm · Layer 2 · live · ${escapeHtml(runDate(layer2.run_id))}</div>${table(layer2Rows(layer2), "Naive (self-check)", layer2.mode === "mcp" ? "time to alert · redo correctness" : "time to alert · Stripe-verified money · redo correctness", false)}${layer2Footer(layer2)}${taskBlock(layer2)}`
    : `<h2>Live agent</h2><p class="empty">No Layer 2 results yet. Run: npx tsx --env-file=.env evals/live/run.ts</p>`;
  const caveat = layer2?.mode === "mcp" ? `${CAVEAT} Layer 2 Proxy ran over MCP against a server.` : `${CAVEAT} Layer 2 Proxy ran in process, not over MCP.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy scoreboard</title><style>${CSS}</style></head>
<body><main class="slide">
<header><h1><span>Proxy</span> scoreboard</h1><div class="sub">the undo layer for AI agents</div></header>
<div class="grid"><section>${first}</section><section>${second}</section></div>
<p class="caveat">${escapeHtml(caveat)}</p>
</main></body></html>
`;
}

function latest<T>(prefix: string, dir: string): T | null {
  if (!existsSync(dir)) {
    return null;
  }
  const names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  const newest = names.at(-1);
  return newest ? (JSON.parse(readFileSync(join(dir, newest), "utf8")) as T) : null;
}

/** The page built from the newest Layer 1 and Layer 2 result files. */
export function renderLatestScoreboard(dir: string = RESULTS_DIR): string {
  return renderScoreboard(latest<Layer1Results>("layer1-", dir), latest<Layer2Results>("layer2-", dir));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(dirname(SCOREBOARD_FILE), { recursive: true });
  writeFileSync(SCOREBOARD_FILE, renderLatestScoreboard());
  console.log(`Wrote ${SCOREBOARD_FILE}`);
}
