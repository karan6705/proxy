import { beforeEach, describe, expect, it } from "vitest";
import { createSimulatedClock } from "../orchestrator/clock.js";
import { DEFAULT_PARAMS } from "../orchestrator/params.js";
import { createRuntime, type Runtime } from "../orchestrator/runtime.js";
import { createMemoryStore } from "../db/index.js";
import { createStandInInkbox } from "../orchestrator/standin-inkbox.js";
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
  clock = createSimulatedClock(START);
  // No env: in-memory Store, stand-in Inkbox, fake Stripe. Nothing leaves the process.
  rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: {}, inkbox: createStandInInkbox() });
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
  const booking = await rt.merchants.book({
    merchant_id: "airline",
    task_id,
    task_email: `${task_id}@tasks.proxy.example`,
    item: "Flight SFO to JFK, Nov 3",
    dates: { start: "2026-11-03" },
    amount: 41_200,
    booked_at: clock.now(),
    defer_confirmation: true,
  });
  const flight = action(task_id, { action_id: "act_flight", summary: "Flight SFO to JFK, Nov 3", amount: 41_200, ref: booking.ref });
  rt.fakePayments?.addCharge(booking.stripe_charge_id, "act_flight", 41_200);
  await rt.proxy.onAction(flight);
  return flight;
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

  it("log_intent asks Inkbox for one identity per task", async () => {
    const inkbox = createStandInInkbox();
    const asked: string[] = [];
    rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
      env: {},
      inkbox: { ...inkbox, createTaskAddress: async (id) => (asked.push(id), inkbox.createTaskAddress(id)) },
    });
    const a = await logTask();
    const b = (await tools.log_intent({ ...INTENT, idempotency_key: "other" })).structuredContent;
    expect(b.ok && b.task_id).not.toBe(a.task_id);
    expect(asked).toEqual([a.task_id, b.ok ? b.task_id : ""]);
    expect(asked.every((id) => /^[a-z0-9_]+$/.test(id))).toBe(true);
  });

  it("each demo run gets a fresh task id but reuses the demo identity's address", async () => {
    const store = createMemoryStore();
    const demoRuntime = () =>
      createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { PROXY_DEMO_ROUTES: "1" }, store, inkbox: createStandInInkbox() });

    rt = demoRuntime();
    const a = await logTask();
    expect(a).toMatchObject({ task_id: "task_demo_1", task_email: "task_demo@tasks.proxy.example" });
    expect((await logTask()).task_id).toBe("task_demo_1");
    const other = (await tools.log_intent({ ...INTENT, idempotency_key: "second" })).structuredContent;
    expect(other).toMatchObject({ ok: false, code: "upstream_unavailable", next_action: "stop" });

    // /demo/reset: same Store (as with Supabase), new runtime, next run id. Run 1 stays as history.
    rt = demoRuntime();
    expect(await rt.proxy.startDemoTask()).toBe("task_demo_2");
    const b = (await tools.log_intent({ ...INTENT, idempotency_key: "run2" })).structuredContent;
    expect(b).toMatchObject({ ok: true, task_id: "task_demo_2", task_email: "task_demo@tasks.proxy.example" });
    expect(await store.getIntent("task_demo_1")).not.toBeNull();
  });

  it("mail to the demo identity is captured into the current run, and list_chains shows only that run", async () => {
    const store = createMemoryStore();
    const demoRuntime = () =>
      createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { PROXY_DEMO_ROUTES: "1" }, store, inkbox: createStandInInkbox() });
    const flightMail = {
      message_id: "m1",
      from: "Skyline Demo Air <bookings@skylinedemoair.example>",
      to: ["task-demo@inkboxmail.com"],
      subject: "Your flight is confirmed",
      text: "Confirmed",
      html: `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FlightReservation",
        reservationNumber: "AIR-1",
        reservationFor: { "@type": "Flight", departureTime: "2026-11-03T08:00:00-08:00" },
        totalPrice: "412.00",
        priceCurrency: "USD",
      })}</script>`,
    };

    for (const run of [1, 2]) {
      rt = demoRuntime();
      await rt.proxy.startDemoTask();
      await tools.log_intent({ ...INTENT, idempotency_key: `run${run}` });
      const r = await rt.capture.handleEmail({ ...flightMail, message_id: `m${run}` });
      expect(r.status).toBe("captured");
      // Capture returns its own copy; what reaches the Store and the orchestrator is re-pointed.
      expect((await store.listActions(`task_demo_${run}`)).map((x) => x.action_id)).toEqual([`act_task_demo_${run}_air-1`]);
    }

    const list = (await tools.list_chains({})).structuredContent;
    expect(list.ok && list.chains.map((c) => c.task_id)).toEqual(["task_demo_2"]);
    expect(await store.listActions("task_demo_1")).toHaveLength(1);
    expect(await store.listActions("task_demo")).toHaveLength(0);
  });

  it("rejects task ids outside [a-z0-9_]", async () => {
    rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
      env: { PROXY_DEMO_ROUTES: "1", INKBOX_DEMO_TASK_ID: "Task-Demo" },
      inkbox: createStandInInkbox(),
    });
    expect((await tools.log_intent(INTENT)).structuredContent).toMatchObject({ ok: false, code: "invalid_input" });
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

    // The widget's view-only _meta: recovered money only for Stripe-verified actions, plus each window.
    const chain = await tools.get_chain({ chain_id: `chain_${task_id}` });
    expect(chain.structuredContent).toMatchObject({ ok: true, actions: [{ action_id: "act_flight", stripe_verified: true }] });
    expect("_meta" in chain && chain._meta).toMatchObject({ server_now: clock.now(), recovered: { act_flight: 41_200 } });
    expect("_meta" in chain && chain._meta.windows.act_flight).toBe("2026-10-26T10:00:00.000Z");
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
    const flight = await captureFlight(task_id);
    await rt.proxy.onAction(action(task_id, { action_id: "act_flight_dup", summary: "Flight SFO to JFK, Nov 3", amount: 41_200, ref: flight.ref }));
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
