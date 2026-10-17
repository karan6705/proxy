import { describe, expect, it } from "vitest";
import type { Action, Chain, EventRow, Intent } from "../types.js";
import { createMemoryStore } from "./memory.js";
import { createSupabaseStore } from "./supabase.js";

const intent: Intent = {
  task_id: "t1",
  task_email: "t1@x.test",
  goal: "Book Nov 13",
  constraints: { dates: { start: "2026-11-13" } },
  preferences: { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false },
  created_at: "2026-11-01T00:00:00.000Z",
};
const action: Action = {
  action_id: "a1",
  task_id: "t1",
  merchant: "airline",
  category: "flight",
  summary: "SFO to JFK Nov 3",
  amount: 41200,
  dates: { start: "2026-11-03" },
  ref: "ABC123",
  source: "email",
  received_at: "2026-11-01T01:00:00.000Z",
  state: "found",
};
const chain: Chain = {
  chain_id: "c1",
  task_id: "t1",
  root_action_id: "a1",
  action_ids: ["a1"],
  money_at_risk: 41200,
  window_ends_at: "2026-11-02T01:00:00.000Z",
  state: "detected",
  alerts: [],
  plan: [],
  steps: [],
};
const event = (kind: EventRow["kind"]): EventRow => ({
  run_id: "r",
  arm: "proxy",
  scenario_id: "demo",
  layer: "scripted",
  kind,
  tool_name: null,
  task_id: "t1",
  chain_id: null,
  action_id: null,
  outcome: null,
  tokens_in: null,
  tokens_out: null,
  timestamp: "2026-11-01T01:00:00.000Z",
});

describe("memory store", () => {
  it("round-trips intent, action, chain and steps", async () => {
    const s = createMemoryStore();
    await s.putIntent(intent, "k1");
    await s.upsertAction(action);
    await s.upsertChain(chain);
    await s.appendStep({
      chain_id: "c1", action_id: "a1", route: "self_serve", protocol_state: null, round: 0,
      message: "cancel", outcome: "pending", stripe_ref: null, at: "2026-11-01T02:00:00.000Z",
    });
    expect(await s.getIntent("t1")).toEqual(intent);
    expect(await s.listActions("t1")).toEqual([action]);
    expect((await s.getChain("c1"))?.steps).toHaveLength(1);
    expect((await s.listChains("t1"))).toHaveLength(1);
    expect(await s.listChains("other")).toHaveLength(0);
  });

  it("returns the first intent for a repeated idempotency key", async () => {
    const s = createMemoryStore();
    await s.putIntent(intent, "k1");
    const again = await s.putIntent({ ...intent, task_id: "t2", goal: "different" }, "k1");
    expect(again.task_id).toBe("t1");
    expect(await s.getIntent("t2")).toBeNull();
    expect((await s.getIntentByIdempotencyKey("k1"))?.task_id).toBe("t1");
  });

  it("counts evidence from the log and actions", async () => {
    const s = createMemoryStore();
    await s.upsertAction(action);
    await s.logEvent(event("email_in"));
    await s.logEvent(event("email_in"));
    await s.logEvent(event("stripe_event"));
    await s.logEvent(event("sms_out"));
    expect(await s.countEvidence("t1")).toEqual({ emails: 2, stripe_events: 1, actions: 1 });
  });

  it("keeps the event log append-only", async () => {
    const s = createMemoryStore();
    await s.logEvent(event("email_in"));
    const [row] = s.events();
    expect(() => {
      (row as EventRow).outcome = "tampered";
    }).toThrow();
    expect(s.events()).toHaveLength(1);
  });

  it("keeps one lesson per mistake code", async () => {
    const s = createMemoryStore();
    const l = { mistake_code: "wrong_date", what_happened: "x", lesson: "y", created_at: "2026-11-01T00:00:00.000Z" };
    await s.addLesson(l);
    await s.addLesson({ ...l, lesson: "z" });
    expect(await s.listLessons()).toEqual([{ ...l, lesson: "z" }]);
  });
});

describe("supabase store", () => {
  it("inserts events with POST only and never sends the key in a URL", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const s = createSupabaseStore({ url: "https://p.supabase.co", serviceRoleKey: "SECRET", fetchImpl });
    await s.logEvent(event("email_in"));
    expect(calls).toEqual([{ url: "https://p.supabase.co/rest/v1/events", method: "POST" }]);
    expect(JSON.stringify(calls)).not.toContain("SECRET");
  });

  it("maps rows back to contract types", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ ...action, amount: 41200, received_at: "2026-11-01T01:00:00+00:00" }]),
        { status: 200 },
      )) as unknown as typeof fetch;
    const s = createSupabaseStore({ url: "https://p.supabase.co", serviceRoleKey: "k", fetchImpl });
    expect(await s.getAction("a1")).toEqual(action);
  });

  it("surfaces PostgREST errors without the key", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 401 })) as unknown as typeof fetch;
    const s = createSupabaseStore({ url: "https://p.supabase.co", serviceRoleKey: "SECRET", fetchImpl });
    await expect(s.getIntent("t1")).rejects.toThrow(/401 boom/);
    await expect(s.getIntent("t1")).rejects.not.toThrow(/SECRET/);
  });
});
