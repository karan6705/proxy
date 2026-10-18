import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import type { SimulatedClock } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { checkIntent, intentQuestion, parseRequest } from "./intent-words.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";

const HUMAN = "+15550001111";
const AGENT = { dates: { start: "2026-11-03", end: "2026-11-06" }, budget_total: 150_000 };

describe("reading the human's words", () => {
  it("finds dates and a budget, deterministically", () => {
    expect(parseRequest("Book my NYC trip for the Nov 13 conference, under $1,500", 2026)).toEqual({ dates: { start: "2026-11-13" }, budget_total: 150_000 });
    expect(parseRequest("November 13-16, budget of $2k", 2026)).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 200_000 });
    expect(parseRequest("from the 13th of November to the 16th of November", 2026)).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" } });
    expect(parseRequest("2026-11-13 to 2026-11-16", 2026)).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" } });
    expect(parseRequest("just get me there", 2026)).toEqual({});
  });

  it("only fields the human mentioned can disagree, and a start date keeps the trip's length", () => {
    expect(checkIntent({ ...AGENT, dates: { start: "2026-11-13", end: "2026-11-16" } }, "NYC for the Nov 13 conference, under $1,500", 2026)).toEqual({ status: "agrees" });
    expect(checkIntent(AGENT, "NYC for the Nov 13 conference", 2026)).toEqual({
      status: "disagrees",
      understood: "Nov 3 to Nov 6",
      said: "Nov 13 to Nov 16",
      corrected: { dates: { start: "2026-11-13", end: "2026-11-16" } },
    });
    expect(checkIntent(AGENT, undefined, 2026)).toEqual({ status: "absent" });
  });
});

describe("numeric and day-only dates", () => {
  it("reads M/D, D/M, M/D/YYYY, two-digit years and ranges", () => {
    expect(parseRequest("flying out 11/13", 2026)).toEqual({ dates: { start: "2026-11-13" } });
    expect(parseRequest("flying out 13/11", 2026)).toEqual({ dates: { start: "2026-11-13" } });
    expect(parseRequest("11/13/2026 to 11/16/2026", 2025)).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" } });
    expect(parseRequest("13/11/26 - 16/11/26", 2025)).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" } });
    expect(parseRequest("2/30 please", 2026)).toEqual({});
  });

  it("marks a date valid both ways as ambiguous, and a range only if every part reads both ways", () => {
    expect(parseRequest("the conference is 3/11", 2026)).toEqual({ dates: { start: "2026-03-11" }, ambiguous: { written: "3/11", other: { start: "2026-11-03" } } });
    expect(parseRequest("3/11-3/14", 2026)).toEqual({ dates: { start: "2026-03-11", end: "2026-03-14" } });
    expect(parseRequest("5/5", 2026)).toEqual({ dates: { start: "2026-05-05" } });
  });

  it("reads 'the 13th' in the reference month, or the next one once the day has passed", () => {
    expect(parseRequest("for the 13th, under $900", 2026, "2026-11-01")).toEqual({ dates: { start: "2026-11-13" }, budget_total: 90_000 });
    expect(parseRequest("from the 13th to the 16th", 2026, "2026-11-01")).toEqual({ dates: { start: "2026-11-13", end: "2026-11-16" } });
    expect(parseRequest("the 13th", 2026, "2026-10-25")).toEqual({ dates: { start: "2026-11-13" } });
    expect(parseRequest("the 13th of November", 2026, "2026-10-25")).toEqual({ dates: { start: "2026-11-13" } });
    expect(parseRequest("Nov 13", 2026)).toEqual({ dates: { start: "2026-11-13" } });
  });

  it("an ambiguous date the agent read one way is a question with both readings", () => {
    const check = checkIntent(AGENT, "NYC for the conference on 3/11", 2026);
    expect(check).toEqual({
      status: "disagrees",
      understood: "Nov 3 to Nov 6",
      said: "3/11 (Mar 11 or Nov 3)",
      corrected: { dates: { start: "2026-03-11", end: "2026-03-14" } },
      ambiguous: { written: "3/11", agent_reading: "Nov 3", choices: [{ label: "Mar 11", corrected: { dates: { start: "2026-03-11", end: "2026-03-14" } } }, { label: "Nov 3" }] },
    });
    expect(intentQuestion(check)).toBe("You wrote 3/11. Your agent read it as Nov 3. Did you mean Mar 11 or Nov 3? Reply 1 or 2.");
    // The other way round, reply 1 is still the reading the agent didn't take; with today, each reading is its next occurrence.
    const misread = checkIntent({ dates: { start: "2027-03-11", end: "2027-03-14" } }, "landing 3/11", 2026, "2026-10-25T14:00:00.000Z");
    expect(misread).toMatchObject({ said: "3/11 (Mar 11 or Nov 3)", corrected: { dates: { start: "2026-11-03", end: "2026-11-06" } } });
    expect(intentQuestion(misread)).toBe("You wrote 3/11. Your agent read it as Mar 11. Did you mean Nov 3 or Mar 11? Reply 1 or 2.");
  });

  it("an ambiguous date that matches neither reading is a plain disagreement", () => {
    expect(checkIntent({ ...AGENT, dates: { start: "2026-11-13", end: "2026-11-16" } }, "the conference is 3/11", 2026)).toEqual({
      status: "disagrees",
      understood: "Nov 13 to Nov 16",
      said: "Mar 11 to Mar 14",
      corrected: { dates: { start: "2026-03-11", end: "2026-03-14" } },
    });
  });

  it("a numeric or day-only date the agent matches agrees, and one it doesn't disagrees", () => {
    expect(checkIntent({ ...AGENT, dates: { start: "2026-11-13", end: "2026-11-16" } }, "11/13 to 11/16", 2026)).toEqual({ status: "agrees" });
    expect(checkIntent(AGENT, "it's on the 13th", 2026)).toMatchObject({ status: "disagrees", understood: "Nov 3 to Nov 6", said: "Nov 13 to Nov 16" });
  });

  it("words with no date or budget are not checkable", () => {
    expect(checkIntent(AGENT, "it's on my calendar, book the usual", 2026)).toEqual({ status: "absent", checkable: false });
  });
});

describe("log_intent with original_request", () => {
  let clock: SimulatedClock;
  let rt: Runtime;
  let inkbox: ReturnType<typeof createStandInInkbox>;
  let tools: ReturnType<typeof createToolHandlers>;
  const texts = () => inkbox.outbox.flatMap((o) => (o.kind === "text" ? [o.body] : []));
  const reply = (body: string) =>
    rt.human.handleInbound({ from: HUMAN, body, via: "imessage" });
  const log = (original_request?: string) =>
    tools.log_intent({
      goal: "NYC trip for the conference",
      constraints: AGENT,
      idempotency_key: "intent-words",
      ...(original_request !== undefined ? { original_request } : {}),
    });

  beforeEach(() => {
    clock = createSimulatedClock("2026-10-25T10:00:00.000Z");
    inkbox = createStandInInkbox();
    rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { HUMAN_PHONE: HUMAN }, store: createMemoryStore(), inkbox });
    tools = createToolHandlers(() => rt.proxy);
  });

  it("agrees: sends nothing", async () => {
    const r = (await log("Nov 3 to Nov 6, under $1,500")).structuredContent;
    expect(r).toMatchObject({ ok: true, intent_check: { status: "agrees" } });
    expect(r).not.toHaveProperty("next_action");
    expect(texts()).toEqual([]);
  });

  it("words with nothing checkable: nothing sent, and the result says so", async () => {
    const res = await log("it's on my calendar");
    expect(res.structuredContent).toMatchObject({ ok: true, intent_check: { status: "absent" } });
    expect(res.structuredContent).not.toHaveProperty("next_action");
    expect(res.content[0]?.text).toContain("Nothing in the human's words could be checked");
    expect(texts()).toEqual([]);
  });

  it("an ambiguous 3/11: the human is asked, and reply 1 picks March 11", async () => {
    const r = (await log("the conference is 3/11")).structuredContent;
    expect(r).toMatchObject({ ok: true, next_action: "wait_for_human", intent_check: { status: "disagrees", understood: "Nov 3 to Nov 6", said: "3/11 (Mar 11 or Nov 3)" } });
    expect(texts()).toEqual(["You wrote 3/11. Your agent read it as Nov 3. Did you mean Mar 11 or Nov 3? Reply 1 or 2."]);
    await reply("1");
    expect(texts().at(-1)).toBe("Got it: Mar 11 to Mar 14. Your agent will use that.");
    if (!r.ok) throw new Error("log_intent failed");
    // Mar 11 has passed on Oct 25, 2026, so the reading is next year's.
    expect((await rt.store.getIntent(r.task_id))?.constraints.dates).toEqual({ start: "2027-03-11", end: "2027-03-14" });
    expect((await log("the conference is 3/11")).structuredContent).toMatchObject({ intent_check: { status: "confirmed_human", said: "Mar 11 to Mar 14" }, constraints: { dates: { start: "2027-03-11", end: "2027-03-14" } } });
  });

  it("an ambiguous 3/11: reply 2 confirms the agent's Nov 3", async () => {
    const r = (await log("the conference is 3/11")).structuredContent;
    if (!r.ok) throw new Error("log_intent failed");
    await reply("2");
    expect(texts().at(-1)).toBe("Okay, keeping Nov 3 to Nov 6.");
    expect((await rt.store.getIntent(r.task_id))?.constraints.dates).toEqual(AGENT.dates);
    expect((await log("the conference is 3/11")).structuredContent).toMatchObject({ intent_check: { status: "confirmed_agent" } });
  });

  it("absent: nothing to check, nothing sent", async () => {
    const r = (await log()).structuredContent;
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("intent_check");
    expect(texts()).toEqual([]);
  });

  it("disagrees, then the human replies 1: their words win", async () => {
    const r = (await log("Book my NYC trip for the Nov 13 conference")).structuredContent;
    expect(r).toMatchObject({ ok: true, next_action: "wait_for_human", intent_check: { status: "disagrees", understood: "Nov 3 to Nov 6", said: "Nov 13 to Nov 16" } });
    expect(texts()).toEqual(["Your agent understood Nov 3 to Nov 6. You said Nov 13 to Nov 16. Reply 1 for Nov 13 to Nov 16 or 2 for Nov 3 to Nov 6."]);

    await reply("1");
    expect(texts().at(-1)).toBe("Got it: Nov 13 to Nov 16. Your agent will use that.");
    if (!r.ok) throw new Error("log_intent failed");
    expect((await rt.store.getIntent(r.task_id))?.constraints.dates).toEqual({ start: "2026-11-13", end: "2026-11-16" });

    // The agent asks again with the same key and gets the human's answer.
    const again = (await log("Book my NYC trip for the Nov 13 conference")).structuredContent;
    expect(again).toMatchObject({ ok: true, intent_check: { status: "confirmed_human" }, constraints: { dates: { start: "2026-11-13", end: "2026-11-16" } } });
    expect(again).not.toHaveProperty("next_action");
  });

  it("disagrees, then the human replies 2: the agent's version stands", async () => {
    const r = (await log("Book my NYC trip for the Nov 13 conference")).structuredContent;
    if (!r.ok) throw new Error("log_intent failed");
    await reply("2");
    expect(texts().at(-1)).toBe("Okay, keeping Nov 3 to Nov 6.");
    expect((await rt.store.getIntent(r.task_id))?.constraints.dates).toEqual(AGENT.dates);
    expect((await log("Book my NYC trip for the Nov 13 conference")).structuredContent).toMatchObject({ intent_check: { status: "confirmed_agent" } });
  });
});
