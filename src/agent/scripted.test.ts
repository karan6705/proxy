import { describe, expect, it, vi } from "vitest";
import { DEMO_TASK_EMAIL, DEMO_TASK_ID, demoMismatches } from "../tools/stubs.js";
import type { Action } from "../types.js";
import type { ToolClient } from "./mcp-client.js";
import { createMockAgentPayments } from "./payments.js";
import {
  createDemoClock,
  createHttpDemoControl,
  DEMO_START,
  LATE_CONFIRMATION_DELAY_MS,
  resetScriptedDemo,
  runScriptedDemo,
  type DemoControl,
} from "./scripted.js";
import type { ConfirmationEnvelope } from "./stub-merchants.js";
import { StubMerchants } from "./stub-merchants.js";

function fakeClient(fixableNow: string[] = []): ToolClient & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === "log_intent") {
        return { ok: true, task_id: DEMO_TASK_ID, task_email: DEMO_TASK_EMAIL } as T;
      }
      if (name === "review") {
        return {
          ok: true,
          status: "chain_open",
          mismatches: demoMismatches,
          fixable_now: fixableNow,
          chain_ids: ["chain_demo"],
          evidence_seen: { emails: 4, stripe_events: 3, actions: 4 },
        } as T;
      }
      if (name === "undo") {
        return { ok: true, accepted: fixableNow, requires_human: [], chain_id: "chain_demo" } as T;
      }
      throw new Error(`Unexpected tool ${name}`);
    },
    async close() {},
  };
}

function fakeControl(events: string[]): DemoControl & { confirmations: ConfirmationEnvelope[]; hostActions: Action[] } {
  const confirmations: ConfirmationEnvelope[] = [];
  const hostActions: Action[] = [];
  return {
    confirmations,
    hostActions,
    async deliver(envelope) {
      events.push(`confirmation:${envelope.action.merchant}`);
      confirmations.push(envelope);
    },
    async endSession() {
      events.push("session-ended");
    },
    async reset() {
      events.push("reset");
    },
    async sendHostArrival(action) {
      events.push("host-email");
      hostActions.push(action);
    },
  };
}

describe("scripted demo", () => {
  it("models the airline as self-serve and uses the transfer support address", () => {
    const merchants = new StubMerchants(createMockAgentPayments(), fakeControl([]));

    expect(merchants.get("airline")).toMatchObject({ has_agent: false });
    expect(merchants.get("airline")?.agent_identity).toBeUndefined();
    expect(merchants.get("transfer")).toMatchObject({
      has_agent: false,
      support_email: "support@metrotransfer.example",
    });
  });

  it("ends the session before all merchant confirmations arrive", async () => {
    const events: string[] = [];
    const client = fakeClient();
    const control = fakeControl(events);
    const clock = createDemoClock();

    const result = await runScriptedDemo({
      client,
      payments: createMockAgentPayments(),
      clock,
      control,
      logger: { log: vi.fn() },
    });

    expect(client.calls.map((call) => call.name)).toEqual(["log_intent", "review"]);
    expect(events).toEqual(["host-email", "session-ended", "confirmation:airline", "confirmation:hotel", "confirmation:transfer"]);
    expect(control.confirmations).toHaveLength(3);
    expect(result.undo).toBeNull();
    expect(clock.nowMs()).toBe(Date.parse(DEMO_START) + LATE_CONFIRMATION_DELAY_MS + 3_000);
  });

  it("passes exactly fixable_now to undo", async () => {
    const client = fakeClient(["act_flight"]);
    await runScriptedDemo({
      client,
      payments: createMockAgentPayments(),
      clock: createDemoClock(),
      control: fakeControl([]),
      logger: { log: vi.fn() },
    });

    expect(client.calls.find((call) => call.name === "undo")?.args).toEqual({
      action_ids: ["act_flight"],
      reason: "The recorded actions use Nov 3, but the intent requires Nov 13.",
    });
  });

  it("reset calls the demo reset control", async () => {
    const reset = vi.fn(async () => undefined);
    await resetScriptedDemo({ reset });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("builds the documented demo HTTP endpoints", async () => {
    const requests: URL[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requests.push(new URL(String(input)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const control = createHttpDemoControl("http://localhost:3000/mcp", fetchMock as typeof fetch);
    await control.endSession("task_demo");
    await control.reset();

    expect(requests.map((url) => `${url.pathname}${url.search}`)).toEqual([
      "/demo/end-session?task_id=task_demo",
      "/demo/reset",
    ]);
  });
});
