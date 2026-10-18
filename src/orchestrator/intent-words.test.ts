import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import type { SimulatedClock } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { checkIntent, parseRequest } from "./intent-words.js";
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
