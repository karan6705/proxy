import { beforeEach, describe, expect, it } from "vitest";
import { createSimulatedClock } from "../orchestrator/clock.js";
import { DEFAULT_PARAMS } from "../orchestrator/params.js";
import { createRuntime, type Runtime } from "../orchestrator/runtime.js";
import type { Action, SimulatedClock } from "../types.js";
import { createToolHandlers } from "./handlers.js";

const START = "2026-10-25T10:00:00.000Z";
const INTENT = {
  goal: "NYC trip for the Nov 13 conference, under $1,500",
  constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 150_000 },
  idempotency_key: "demo:nyc",
};

let clock: SimulatedClock;
let rt: Runtime;
let tools: ReturnType<typeof createToolHandlers>;

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  clock = createSimulatedClock(START);
  rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES);
  tools = createToolHandlers(() => rt.proxy);
});

function action(task_id: string, over: Partial<Action>): Action {
  return {
    action_id: "act_x",
    task_id,
    merchant: "airline",
    category: "flight",
    summary: "",
    amount: 0,
    dates: { start: "2026-11-03" },
    ref: "",
    source: "email",
    received_at: clock.now(),
    state: "found",
    ...over,
  };
}

async function logTask() {
  const r = await tools.log_intent(INTENT);
  if (!r.structuredContent.ok) throw new Error("log_intent failed");
  return r.structuredContent as { ok: true; task_id: string; task_email: string };
}

async function captureFlight(task_id: string) {
  const flight = action(task_id, { action_id: "act_flight", summary: "Flight SFO to JFK, Nov 3", amount: 41_200, ref: "AIR-1" });
  rt.fakePayments?.addCharge("ch_1", "act_flight", 41_200);
  rt.merchants.bookings.set("AIR-1", {
    request: { merchant_id: "airline", task_id, task_email: "", item: "Flight", dates: { start: "2026-11-03" }, amount: 41_200, booked_at: clock.now() },
    charge_id: "ch_1",
    cancelled: false,
  });
  await rt.proxy.onAction(flight);
}

describe("tools wired to the orchestrator", () => {
  it("log_intent creates the intent and task address, idempotently", async () => {
    const a = await logTask();
    expect(a.task_email).toBe(`${a.task_id}@tasks.proxy.example`);
    expect((await rt.store.getIntent(a.task_id))?.preferences).toEqual(DEFAULT_PARAMS.DEFAULT_PREFERENCES);
    const again = await logTask();
    expect(again.task_id).toBe(a.task_id);
    const conflict = await tools.log_intent({ ...INTENT, goal: "something else" });
    expect(conflict.structuredContent).toMatchObject({ ok: false, code: "idempotency_conflict", next_action: "fix_now" });
  });

  it("review returns not_found for an unknown task", async () => {
    const r = await tools.review({ task_id: "nope" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "not_found", retryable: false });
  });

  it("review calls compare: the host email mismatch is not self-undoable", async () => {
    const { task_id } = await logTask();
    await rt.proxy.onAction(action(task_id, { action_id: "act_host", merchant: "host", category: "message", summary: "Arrival email", source: "agent", ref: "HOST-1" }));
    const r = (await tools.review({ task_id })).structuredContent;
    expect(r).toMatchObject({ ok: true, status: "chain_open", fixable_now: [] });
    if (!r.ok) return;
    expect(r.mismatches[0]).toMatchObject({ action_id: "act_host", field: "dates", expected: "2026-11-13", actual: "2026-11-03" });
    expect(r.mismatches[0]?.evidence?.source_action_id).toBe("act_host");
  });

  it("during the session the agent can self-undo the flight, which is refunded and verified", async () => {
    const { task_id } = await logTask();
    await captureFlight(task_id);
    const r = (await tools.review({ task_id })).structuredContent;
    expect(r).toMatchObject({ ok: true, fixable_now: ["act_flight"] });

    const u = (await tools.undo({ action_ids: ["act_flight", "act_unknown"], reason: "wrong date" })).structuredContent;
    expect(u).toMatchObject({ ok: true, accepted: ["act_flight"], requires_human: ["act_unknown"] });
    expect((await rt.store.getAction("act_flight"))?.state).toBe("verified");

    const again = (await tools.undo({ action_ids: ["act_flight"], reason: "retry" })).structuredContent;
    expect(again).toMatchObject({ accepted: ["act_flight"] });
    expect(rt.fakePayments?.refunds.size).toBe(1);
  });

  it("after the session ends, late confirmations extend the chain and everything goes to the human", async () => {
    const { task_id } = await logTask();
    await rt.proxy.onAction(action(task_id, { action_id: "act_host", merchant: "host", category: "message", summary: "Arrival email", source: "agent", ref: "HOST-1" }));
    await tools.review({ task_id });
    rt.proxy.deps.sessions.end(task_id);

    clock.advance(5 * 60_000);
    await captureFlight(task_id);
    await rt.proxy.onAction(action(task_id, { action_id: "act_hotel", merchant: "hotel", category: "hotel", summary: "Hotel, 3 nights", amount: 64_000, ref: "HTL-1", dates: { start: "2026-11-03", end: "2026-11-06" } }));
    await rt.proxy.onAction(action(task_id, { action_id: "act_transfer", merchant: "transfer", category: "transfer", summary: "Airport transfer", amount: 18_800, ref: "TRF-1" }));

    const list = (await tools.list_chains({ task_id })).structuredContent;
    expect(list).toMatchObject({ ok: true });
    if (!list.ok) return;
    expect(list.chains).toHaveLength(1);
    expect(list.chains[0]).toMatchObject({ action_count: 4, money_at_risk: 124_000, root_summary: "Flight SFO to JFK, Nov 3" });
    // The root is the earliest booked action with a mismatch, even though the host email arrived first.

    const u = (await tools.undo({ action_ids: ["act_flight"], reason: "wrong date" })).structuredContent;
    expect(u).toMatchObject({ accepted: [], requires_human: ["act_flight"], chain_id: null });

    const chain = (await tools.get_chain({ chain_id: list.chains[0]!.chain_id })).structuredContent;
    expect(chain).toMatchObject({ ok: true, state: "detected", next_action: "wait_for_human" });
    if (!chain.ok) return;
    expect(chain.actions.map((a) => [a.action_id, a.route])).toEqual([
      ["act_host", "correction"],
      ["act_flight", "self_serve"],
      ["act_hotel", "reversal_protocol"],
      ["act_transfer", "email_support"],
    ]);
  });

  it("STOP freezes the agent's self-undo until the human replies again", async () => {
    const { task_id } = await logTask();
    await captureFlight(task_id);
    await rt.proxy.onHumanReply({ kind: "stop", received_at: clock.now() });
    const frozen = (await tools.undo({ action_ids: ["act_flight"], reason: "wrong date" })).structuredContent;
    expect(frozen).toMatchObject({ accepted: [], requires_human: ["act_flight"] });
    expect(rt.fakePayments?.refunds.size).toBe(0);

    await rt.proxy.onHumanReply({ kind: "keep", chain_id: `chain_${task_id}`, received_at: clock.now() });
    const after = (await tools.undo({ action_ids: ["act_flight"], reason: "wrong date" })).structuredContent;
    expect(after).toMatchObject({ accepted: ["act_flight"] });
  });

  it("a correction waits for confirmation instead of acting", async () => {
    const { task_id } = await logTask();
    await captureFlight(task_id);
    await rt.proxy.onHumanReply({ kind: "correction", chain_id: `chain_${task_id}`, corrected_text: "ugh no the 13th", received_at: clock.now() });
    expect(rt.proxy.pendingCorrections.get(`chain_${task_id}`)?.corrected_text).toBe("ugh no the 13th");
    expect((await rt.store.getAction("act_flight"))?.state).toBe("found");
  });

  it("a repeated confirmation with the same ref does not create a second action", async () => {
    const { task_id } = await logTask();
    await captureFlight(task_id);
    await rt.proxy.onAction(action(task_id, { action_id: "act_flight_dup", summary: "Flight SFO to JFK, Nov 3", amount: 41_200, ref: "AIR-1" }));
    expect(await rt.store.listActions(task_id)).toHaveLength(1);
  });

  it("get_chain keeps the error contract for unknown chains", async () => {
    const r = await tools.get_chain({ chain_id: "x" });
    expect(r).toMatchObject({ isError: true, structuredContent: { ok: false, code: "not_found", next_action: "fix_now" } });
  });

  it("reversibility answers from Logic", async () => {
    const r = (await tools.reversibility({ merchant: "airline", category: "flight", amount: 41_200 })).structuredContent;
    expect(r).toMatchObject({ ok: true, kind: "cancel_refund", refundable: true, cost_to_reverse: 0 });
  });
});
