import { describe, expect, it } from "vitest";
import type { ToolClient } from "../../src/agent/mcp-client.js";
import { runProxyOverMcp } from "../../evals/live/mcp.js";
import type { SimBooking } from "../../evals/sim.js";

/** The fakes are loosely typed on purpose; this is the one place they meet the real client type. */
const asClient = (value: unknown): ToolClient => value as ToolClient;

const bookings: SimBooking[] = [
  { id: "airline_1", merchant_id: "airline", item: "SFO-JFK", dates: { start: "2026-11-03" }, amount: 41200, booked_at: "2026-10-17T09:00:00.000Z" },
  { id: "hotel_2", merchant_id: "hotel", item: "Harborview Hotel, 3 nights", dates: { start: "2026-11-03", end: "2026-11-06" }, amount: 64000, booked_at: "2026-10-17T09:05:00.000Z" },
];

function fakes(options: { chains?: unknown[][]; reviewOk?: boolean } = {}) {
  const calls: string[] = [];
  const booked: { merchant_id: string; task_id: string; item: string }[] = [];
  const stateSequence = options.chains ?? [
    [{ chain_id: "chain_a", task_id: "task_x", state: "alerted", actions: [], steps: [] }],
    [{ chain_id: "chain_a", task_id: "task_x", state: "redo_requested", actions: [{ action_id: "a", stripe_verified: true }, { action_id: "b", stripe_verified: false }], steps: [{ message: "Merchant agreed $544.00" }] }],
  ];
  let stateCalls = 0;
  const client = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "log_intent") {
        expect(args.constraints).toEqual({ dates: { start: "2026-11-13" } });
        return { ok: true, task_id: "task_x", task_email: "task-x@inkboxmail.com" };
      }
      return options.reviewOk === false
        ? { ok: false, message: "no" }
        : { ok: true, status: "chain_open", mismatches: [{ action_id: "act_task_x_htl-1", field: "dates" }, { action_id: "act_task_x_unknown", field: "amount" }], fixable_now: [], chain_ids: [], evidence_seen: {} };
    },
    async close() {
      calls.push("close");
    },
  };
  const merchants = {
    async book(request: { merchant_id: string; task_id: string; item: string }) {
      booked.push(request);
      return { ref: request.merchant_id === "hotel" ? "HTL-1" : "AIR-1", amount: 0, stripe_charge_id: "ch" };
    },
    async releaseConfirmation(ref: string) {
      calls.push(`release:${ref}`);
    },
  };
  const control = {
    async endSession(taskId: string) {
      calls.push(`end:${taskId}`);
    },
    async deliver() {},
    async reset() {},
    async sendHostArrival() {},
  };
  const fetchImpl = (async (target: URL | string, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    if (path === "/web/state") {
      const body = { chains: stateSequence[Math.min(stateCalls, stateSequence.length - 1)] };
      stateCalls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (path === "/web/reply") {
      calls.push(`reply:${JSON.parse(String(init?.body)).kind}`);
      return new Response("{}", { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, booked, deps: { mcpUrl: "https://proxy.example/mcp", client: asClient(client), merchants, control, fetchImpl, reset: async () => void calls.push("reset"), sleep: async () => undefined, waitMs: 50 } };
}

describe("Layer 2 over MCP (against fakes, no server)", () => {
  const input = { taskId: "L2", trial: 1, logged: { goal: "x", constraints: { dates: { start: "2026-11-13" } } }, bookings };

  it("replays the bookings at the server, ends the session, releases the hotel confirmation, then replies UNDO ALL", async () => {
    const { calls, booked, deps } = fakes();
    const result = await runProxyOverMcp(input, deps);
    expect(calls).toEqual(["reset", "log_intent", "end:task_x", "release:HTL-1", "review", "reply:undo_all"]);
    expect(booked.map((item) => [item.merchant_id, item.task_id])).toEqual([["airline", "task_x"], ["hotel", "task_x"]]);
    expect(result).toMatchObject({ chain_state: "redo_requested", stripe_verified_actions: 1, chain_actions: 2, steps: ["Merchant agreed $544.00"] });
  });

  it("maps the server's action ids back to this episode's booking ids, and keeps ids it does not know", async () => {
    const { deps } = fakes();
    const result = await runProxyOverMcp(input, deps);
    expect(result.flagged).toEqual([{ action: "hotel_2", field: "dates" }, { action: "act_task_x_unknown", field: "amount" }]);
  });

  it("does not reply when the server raises no chain, and still reports what review said", async () => {
    const { calls, deps } = fakes({ chains: [[]] });
    const result = await runProxyOverMcp(input, deps);
    expect(calls).not.toContain("reply:undo_all");
    expect(result).toMatchObject({ chain_state: null, stripe_verified_actions: 0, chain_actions: 0 });
    expect(result.flagged).toHaveLength(2);
  });

  it("logs a placeholder intent when the agent logged nothing, so Proxy has nothing to compare against", async () => {
    const { deps } = fakes();
    const client = asClient({ ...deps.client, async callTool(name: string, args: Record<string, unknown>) {
      if (name === "log_intent") {
        expect(args.goal).toBe("(the agent logged no intent)");
        expect(args.constraints).toEqual({});
        return { ok: true, task_id: "task_x", task_email: "t@x" };
      }
      return { ok: true, status: "clean", mismatches: [], fixable_now: [], chain_ids: [], evidence_seen: {} };
    } });
    await runProxyOverMcp({ ...input, logged: null }, { ...deps, client });
  });

  it("fails loudly if log_intent is refused, and closes a client it opened itself", async () => {
    const { deps } = fakes();
    const client = asClient({ ...deps.client, async callTool() { return { ok: false, message: "bad intent" }; } });
    await expect(runProxyOverMcp(input, { ...deps, client })).rejects.toThrow("log_intent: bad intent");
  });
});
