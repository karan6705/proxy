import { describe, expect, it } from "vitest";
import type { Action, Intent, Mismatch } from "../types.js";
import { createTestCharge } from "./charge.js";
import { StripeClient, type StripeRequester } from "./client.js";
import { buildDisputeEvidence, buildDisputePacket } from "./dispute.js";
import { verifyRefund, verifyRefundAmount } from "./verify.js";

const action: Action = {
  action_id: "act_123",
  task_id: "task_123",
  merchant: "airline",
  category: "flight",
  summary: "Test flight",
  amount: 41200,
  dates: { start: "2026-11-03" },
  ref: "BOOK-123",
  source: "agent",
  received_at: "2026-10-17T12:00:00.000Z",
  state: "found",
};

describe("Stripe test-mode safety and idempotency", () => {
  it("refuses non-test secret keys", () => {
    expect(() => new StripeClient({ secretKey: "sk_live_do_not_use" })).toThrow(/sk_test_/);
  });

  it("sends the caller's idempotency key to Stripe", async () => {
    const seen: Array<string | undefined> = [];
    const client = new StripeClient({
      secretKey: "sk_test_unit",
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push(headers["Idempotency-Key"]);
        return new Response(
          JSON.stringify({ id: "pi_123", amount: 41200, currency: "usd", status: "succeeded", latest_charge: "ch_123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await createTestCharge(action, "charge:act_123", client);
    await createTestCharge(action, "charge:act_123", client);
    expect(seen).toEqual(["charge:act_123", "charge:act_123"]);
  });
});

describe("refund verification", () => {
  it("trusts only succeeded Stripe refunds", async () => {
    const client: StripeRequester = {
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/v1/payment_intents/search") {
          return { data: [{ id: "pi_123", metadata: { action_id: "act_123" } }], has_more: false } as T;
        }
        return {
          data: [
            { id: "re_pending", amount: 41200, status: "pending" },
            { id: "re_failed", amount: 41200, status: "failed" },
          ],
          has_more: false,
        } as T;
      },
    };
    expect(await verifyRefund("act_123", client)).toBe(false);
  });

  it("accepts succeeded refunds and checks the recovered amount", async () => {
    const client: StripeRequester = {
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/v1/payment_intents/search") {
          return { data: [{ id: "pi_123", metadata: { action_id: "act_123" } }], has_more: false } as T;
        }
        return { data: [{ id: "re_ok", amount: 30000, status: "succeeded" }], has_more: false } as T;
      },
    };
    expect(await verifyRefund("act_123", client)).toBe(true);
    expect(await verifyRefundAmount("pi_123", 30000, client)).toEqual({
      verified: true,
      refunded_amount: 30000,
    });
    expect(await verifyRefundAmount("pi_123", 41200, client)).toEqual({
      verified: false,
      refunded_amount: 30000,
    });
  });
});

describe("dispute evidence", () => {
  it("fills every demo-chain evidence field", () => {
    const intent: Intent = {
      task_id: action.task_id,
      task_email: "task_nyc@tasks.proxy.example",
      goal: "NYC trip for the Nov 13 conference, under $1,500",
      constraints: {
        dates: { start: "2026-11-13", end: "2026-11-16" },
        budget_total: 150_000,
        destination: "NYC",
      },
      preferences: { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false },
      created_at: "2026-11-01T14:00:00.000Z",
    };
    const mismatch: Mismatch = {
      action_id: action.action_id,
      field: "dates",
      expected: "2026-11-13",
      actual: "2026-11-03",
      evidence: {
        source_action_id: action.action_id,
        receipt_fields: { departure_date: "2026-11-03", reservation_number: action.ref },
      },
    };
    const packet = buildDisputePacket({
      intent,
      order: action,
      confirmation_excerpt: "Flight confirmation BOOK-123 for Nov 3.",
      stripe_charge_id: "ch_123",
      mismatch,
      why_wrong: "The order is for Nov 3, but the anchored intent requires Nov 13.",
      message_timeline: [
        {
          at: "2026-11-01T14:05:00.000Z",
          from: "proxy@demo.example",
          to: "support@airline.example",
          body: "Cancel booking BOOK-123 and refund the charge.",
        },
        {
          at: "2026-11-01T14:10:00.000Z",
          from: "support@airline.example",
          to: "proxy@demo.example",
          body: "Cancellation was denied.",
        },
      ],
      deadline: "2026-11-01T18:00:00.000Z",
    });
    const evidence = buildDisputeEvidence(packet);
    const audit = JSON.parse(evidence.uncategorized_text) as Record<string, unknown>;

    expect(packet.order).toEqual(action);
    expect(packet.intent).toEqual(intent);
    expect(packet.mismatch).toEqual(mismatch);
    expect(packet.mismatch.evidence).toBeDefined();
    expect(packet.message_timeline).toHaveLength(2);
    expect(packet.deadline).toBeTruthy();
    expect(Object.values(evidence).every((value) => value !== undefined && value !== "")).toBe(true);
    expect(audit).toMatchObject({
      order: action,
      intent,
      mismatch,
      message_timeline: packet.message_timeline,
      deadline: packet.deadline,
    });
    expect(evidence.customer_communication).toContain("Cancellation was denied.");
  });
});
