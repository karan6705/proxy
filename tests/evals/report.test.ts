import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAVEAT, isComprehensionTask, layer2ByTask, renderLatestResults, renderPitchNumbers, renderResults, type Episode, type Layer1Results, type Layer2Results } from "../../evals/report.js";

const usage = { input_tokens: 10, output_tokens: 5 };
const episode = (task_id: string, arm: "naive" | "proxy", mistakes: number, extra: Partial<Episode> = {}): Episode => ({
  task_id,
  arm,
  truth: Array.from({ length: mistakes }, (_, index) => ({ booking: `b${index}`, field: "dates" })),
  agent: { status: "done", usage },
  ...extra,
});

const layer1: Layer1Results = {
  run_id: "layer1-2026-10-17T23-22-35-970Z",
  not_measured: [{ name: "time to alert", why: "x" }],
  summaries: ["naive", "proxy"].map((arm) => ({
    arm: arm as "naive" | "proxy", scenarios: 34, passed: arm === "proxy" ? 34 : 7, mistakes_expected: 44, mistakes_caught: arm === "proxy" ? 39 : 1, known_misses: 5,
    false_alarms: 1, known_false_alarms: 1, chain_members_expected: 40, chain_members_found: arm === "proxy" ? 40 : 0, outcomes_expected: 39, outcomes_correct: arm === "proxy" ? 39 : 2,
    refund_agreed: arm === "proxy" ? 828500 : 0, refund_expected: 828500, false_done_claims: 0,
  })),
};

const episodes: Episode[] = [
  episode("L2", "naive", 2, { false_done_claim: true }),
  episode("L2", "proxy", 2, { proxy: { caught: 2, false_alarms: [], agreed_refund_total: 41200 } }),
  episode("L5", "naive", 0),
  episode("L5", "proxy", 0, { proxy: { caught: 0, false_alarms: [], agreed_refund_total: 0 } }),
  episode("C1", "naive", 3, { false_done_claim: true }),
  episode("C1", "proxy", 3, { proxy: { caught: 0, false_alarms: [], agreed_refund_total: 0 } }),
];

const layer2: Layer2Results = {
  run_id: "layer2-2026-10-18T00-54-41-756Z",
  model: "claude-haiku-4-5-20251001",
  summary: {
    trials_per_task_arm: 1,
    naive: { episodes: 3, episodes_with_real_mistakes: 2, self_detected: 0, false_done_claims: 2, tokens: 45 },
    proxy: { episodes: 3, episodes_with_real_mistakes: 2, mistakes: 5, caught: 2, false_alarms: 0, refund_agreed: 41200, tokens: 45 },
  },
  episodes,
};

describe("per task counts", () => {
  it("counts mistakes, catches, false alarms and false done claims per task", () => {
    const [l2, l5, c1] = layer2ByTask(episodes);
    expect(l2).toMatchObject({ task_id: "L2", episodes_per_arm: 1, naive_with_mistake: 1, naive_false_done: 1, proxy_mistakes: 2, proxy_caught: 2, proxy_refund_agreed: 41200 });
    expect(l5).toMatchObject({ task_id: "L5", naive_with_mistake: 0, proxy_mistakes: 0, proxy_false_alarms: 0 });
    expect(c1).toMatchObject({ task_id: "C1", proxy_mistakes: 3, proxy_caught: 0 });
  });

  it("treats the C tasks as comprehension errors and everything else as execution errors", () => {
    expect(["C1", "C2"].every(isComprehensionTask)).toBe(true);
    expect(["L1", "L2", "L5"].some(isComprehensionTask)).toBe(false);
  });
});

describe("RESULTS.md", () => {
  const md = renderResults({ data: layer1, file: "layer1-x.json" }, { data: layer2, file: "layer2-y.json" });

  it("has the caveat line, how each layer was measured, and links to the raw logs", () => {
    expect(md).toContain(CAVEAT);
    expect(md).toContain("**How it was measured.**");
    expect(md).toContain("(results/layer1-x.json)");
    expect(md).toContain("(results/layer2-y.json)");
    expect(md).toContain("Proxy ran in process (not over MCP)");
  });

  it("shows counts, and no percentages", () => {
    expect(md).toContain("| Real mistakes caught | 1 / 44 | 39 / 44 |");
    expect(md).toContain("| Refunds agreed by merchants | $0 of $8,285 | $8,285 of $8,285 |");
    expect(md).not.toMatch(/\d\s?%/);
  });

  it("states the execution versus comprehension finding from the data", () => {
    expect(md).toContain("Execution errors (tasks L2, L5");
    expect(md).toContain("Proxy caught 2 / 2 real mistakes");
    expect(md).toContain("Comprehension errors (tasks C1");
    expect(md).toContain("Proxy caught 0 / 3");
    expect(md).toContain("logged the same misreading");
  });

  it("says when Proxy ran over MCP", () => {
    const over = renderResults(null, { data: { ...layer2, mode: "mcp", mcp_url_host: "proxy.example" }, file: "layer2-z.json" });
    expect(over).toContain("over MCP against proxy.example");
    expect(over).toContain("Actions whose refund Stripe shows");
    expect(over).not.toContain("Refunds agreed by merchants | n/a");
    expect(over).toContain("No Layer 1 results yet");
  });

  it("builds from the newest files in a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    writeFileSync(join(dir, "layer1-2026-10-17T10-00-00-000Z.json"), JSON.stringify({ ...layer1, run_id: "old" }));
    writeFileSync(join(dir, "layer1-2026-10-18T10-00-00-000Z.json"), JSON.stringify({ ...layer1, run_id: "new" }));
    const out = renderLatestResults(dir);
    expect(out).toContain("layer1-2026-10-18T10-00-00-000Z.json");
    expect(out).not.toContain("layer1-2026-10-17T10-00-00-000Z.json");
    expect(out).toContain("No Layer 2 results yet");
  });
});

describe("the intent check rerun and the pitch numbers", () => {
  const intentRun: Layer2Results = {
    run_id: "intentcheck-2026-10-18T02-37-52-316Z",
    model: "claude-haiku-4-5-20251001",
    summary: { trials_per_task_arm: 3, naive: { episodes: 3, episodes_with_real_mistakes: 3, self_detected: 0, false_done_claims: 3, tokens: 1 }, proxy: { episodes: 3, episodes_with_real_mistakes: 3, mistakes: 9, caught: 0, false_alarms: 0, refund_agreed: 0, tokens: 1 } },
    episodes: [
      episode("C1", "naive", 3, { false_done_claim: true }),
      ...[1, 2, 3].map(() => episode("C1", "proxy", 3, { proxy: { caught: 0, false_alarms: [], agreed_refund_total: 0, intent_check: { status: "agrees", original_request_passed: true } } })),
    ],
  };
  const md = renderResults({ data: layer1, file: "layer1-x.json" }, { data: layer2, file: "layer2-y.json" }, { data: intentRun, file: "intentcheck-z.json" });

  it("reports the rerun count as it came out, with the reason and how it was measured", () => {
    expect(md).toContain("## Layer 2 rerun: the intent check from the human's own words");
    expect(md).toContain("**Result: Proxy caught 0 / 9 of the real mistakes with the human's words passed in**");
    expect(md).toContain("the check disagreed in 0 of 3 episodes");
    expect(md).toContain("the human's answer is not measured");
    expect(md).toContain("(results/intentcheck-z.json)");
    expect(md).not.toMatch(/\d\s?%/);
  });

  it("leaves the section out when there is no rerun", () => {
    expect(renderResults({ data: layer1, file: "a.json" }, { data: layer2, file: "b.json" })).not.toContain("Layer 2 rerun");
  });

  it("the pitch numbers trace each number to a file and carry the caveats and the do-not-say list", () => {
    const pitch = renderPitchNumbers({ data: layer1, file: "layer1-x.json" }, { data: layer2, file: "layer2-y.json" }, { data: intentRun, file: "intentcheck-z.json" });
    expect(pitch).toContain("`evals/results/layer1-x.json`");
    expect(pitch).toContain("`evals/results/layer2-y.json`");
    // The intent check rerun is not part of the pitch numbers: it is only in the do-not-say list.
    expect(pitch).not.toContain("intentcheck-z.json");
    expect(pitch).toContain("Proxy caught 39 of 44 real mistakes; 5 are documented known misses");
    expect(pitch).toContain("never quote it as how often agents miss things");
    expect(pitch).toContain("## Do not say");
    expect(pitch).toContain("4.8 to 9.3 times");
    expect(pitch).toContain("UCP Checker");
    expect(pitch).toContain("fixes a misread request. The only rerun caught 0 / 9");
    expect(pitch).toContain("when the request has no date");
    expect(pitch).toContain("there is nothing to compare the agent's dates with");
    expect(pitch).not.toMatch(/\d\s?%/);
  });

  it("the pitch numbers say nothing about a layer that has no results", () => {
    const pitch = renderPitchNumbers(null, null);
    expect(pitch).not.toContain("evals/results/layer");
    expect(pitch).not.toContain("evals/results/intentcheck");
    expect(pitch).toContain("## Do not say");
  });
});
