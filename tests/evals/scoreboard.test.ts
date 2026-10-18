import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLatestScoreboard, renderScoreboard, type Layer1Results, type Layer2Results } from "../../evals/scoreboard.js";

const arm = (name: "naive" | "proxy", over: Record<string, number> = {}) => ({
  arm: name, scenarios: 34, passed: 34, mistakes_expected: 44, mistakes_caught: 39, known_misses: 5, false_alarms: 1, known_false_alarms: 1,
  chain_members_expected: 40, chain_members_found: 40, outcomes_expected: 39, outcomes_correct: 39, refund_agreed: 828500, refund_expected: 828500,
  false_done_claims: 0, ...over,
});
const layer1: Layer1Results = {
  run_id: "layer1-2026-10-17T23-22-35-970Z",
  not_measured: [{ name: "time to alert", why: "x" }, { name: "token cost", why: "x" }],
  summaries: [arm("naive", { passed: 7, mistakes_caught: 1, chain_members_found: 0, outcomes_correct: 2, refund_agreed: 0 }), arm("proxy")],
};
const layer2: Layer2Results = {
  run_id: "layer2-2026-10-17T23-57-51-774Z",
  model: "claude-haiku-4-5-20251001",
  summary: {
    trials_per_task_arm: 5,
    naive: { episodes: 25, episodes_with_real_mistakes: 8, self_detected: 3, false_done_claims: 5, tokens: 69245 },
    proxy: { episodes: 25, episodes_with_real_mistakes: 5, mistakes: 6, caught: 6, false_alarms: 0, refund_agreed: 483200, tokens: 99747 },
  },
  episodes: [
    { task_id: "L2", arm: "naive", truth: [{ booking: "airline_2", field: "duplicate" }], agent: { status: "done", usage: { input_tokens: 1, output_tokens: 1 } }, false_done_claim: true },
    { task_id: "L2", arm: "proxy", truth: [{ booking: "airline_2", field: "duplicate" }], agent: { status: "done", usage: { input_tokens: 1, output_tokens: 1 } }, proxy: { caught: 1, false_alarms: [], agreed_refund_total: 41200 } },
    { task_id: "C2", arm: "naive", truth: [{ booking: "airline_1", field: "dates" }], agent: { status: "done", usage: { input_tokens: 1, output_tokens: 1 } }, false_done_claim: true },
    { task_id: "C2", arm: "proxy", truth: [{ booking: "airline_1", field: "dates" }], agent: { status: "done", usage: { input_tokens: 1, output_tokens: 1 } }, proxy: { caught: 0, false_alarms: [], agreed_refund_total: 0 } },
  ],
};

describe("the scoreboard page", () => {
  const html = renderScoreboard(layer1, layer2);

  it("shows counts, never percentages", () => {
    expect(html).toContain("39 / 44");
    expect(html).toContain("34 / 34");
    expect(html).toContain("5 / 25");
    expect(html).toContain("$8,285 / $8,285");
    expect(html).toContain("$4,832");
    const text = html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(text).not.toMatch(/\d\s?%/);
  });

  it("labels the naive column as scripted and carries the caveat line", () => {
    expect(html).toContain("Naive (scripted)");
    expect(html).toContain("not a measured miss rate");
    expect(html).toContain("Counts from actual runs, not rates.");
    expect(html).toContain("Merchants and the clock are our own simulations.");
  });

  it("shows per task counts and the split between execution and comprehension errors", () => {
    expect(html).toContain("Per task");
    expect(html).toContain("flight call times out");
    expect(html).toContain("Execution errors");
    expect(html).toContain("Comprehension errors");
    expect(html).toContain("agent misreads the request, then logs the same misreading");
  });

  it("says how Proxy was run in layer 2", () => {
    expect(html).toContain("Layer 2 Proxy ran in process, not over MCP.");
    expect(renderScoreboard(layer1, { ...layer2, mode: "mcp" })).toContain("Layer 2 Proxy ran over MCP against a server.");
  });

  it("lists what a layer cannot measure as n/a", () => {
    expect(html).toContain("n/a here:");
    expect(html).toContain("time to alert · token cost");
  });

  it("is self-contained: no scripts and no external requests", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("escapes text it was given", () => {
    const hostile = renderScoreboard(layer1, { ...layer2, model: '<img src=x onerror="boom">' });
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img");
  });

  it("says so when a layer has no results yet", () => {
    const empty = renderScoreboard(null, null);
    expect(empty).toContain("No Layer 1 results yet");
    expect(empty).toContain("No Layer 2 results yet");
  });

  it("builds from the newest result files in a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
    writeFileSync(join(dir, "layer1-2026-10-17T10-00-00-000Z.json"), JSON.stringify({ ...layer1, run_id: "layer1-2026-10-17T10-00-00-000Z", summaries: [arm("naive"), arm("proxy", { passed: 1 })] }));
    writeFileSync(join(dir, "layer1-2026-10-18T10-00-00-000Z.json"), JSON.stringify({ ...layer1, run_id: "layer1-2026-10-18T10-00-00-000Z" }));
    const page = renderLatestScoreboard(dir);
    expect(page).toContain("2026-10-18");
    expect(page).not.toContain("1 / 34");
    expect(page).toContain("No Layer 2 results yet");
  });
});
