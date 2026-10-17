import { describe, expect, it } from "vitest";
import type { Action, Intent, Mismatch } from "../types.js";
import { createTestCharge } from "./charge.js";
import { StripeApiError, StripeClient, type StripeErrorLog, type StripeRequester } from "./client.js";
import { buildDisputeEvidence, buildDisputePacket } from "./dispute.js";
import { partialRefund } from "./refund.js";
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

  it("returns an existing succeeded refund with the same durable idempotency key", async () => {
    const calls: string[] = [];
    const client: StripeRequester = {
      async request<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        return {
          data: [
            {
              id: "re_existing",
              amount: 35_020,
              status: "succeeded",
              metadata: { proxy_idempotency_key: "refund:act_123" },
            },
          ],
        } as T;
      },
    };

    await expect(partialRefund("ch_123", 35_020, "refund:act_123", client)).resolves.toEqual({
      refund_id: "re_existing",
      amount: 35_020,
      status: "succeeded",
    });
    expect(calls).toEqual(["GET /v1/refunds"]);
  });

  it("maps raw Stripe errors to safe caller errors and logs details only through the server logger", async () => {
    const logs: StripeErrorLog[] = [];
    const client = new StripeClient({
      secretKey: "sk_test_unit",
      logError: (details) => logs.push(details),
      fetch: async () => new Response(
        JSON.stringify({ error: { message: "raw decline details for internal logs", code: "card_declined" } }),
        { status: 402, headers: { "content-type": "application/json", "request-id": "req_123" } },
      ),
    });

    const error = await client.request("POST", "/v1/refunds").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({ code: "stripe_invalid_request", message: "Stripe rejected the request" });
    expect(String(error)).not.toContain("raw decline details");
    expect(logs).toEqual([
      {
        code: "stripe_invalid_request",
        status: 402,
        stripe_code: "card_declined",
        request_id: "req_123",
        detail: "raw decline details for internal logs",
      },
    ]);
  });
});

describe("refund verification", () => {
  it("rejects zero, missing, pending, and mismatched refunds with reason codes", async () => {
    let refunds: Array<{ id: string; amount: number; status: string }> = [];
    const client: StripeRequester = {
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/v1/payment_intents/search") {
          return { data: [{ id: "pi_123", metadata: { action_id: "act_123" } }], has_more: false } as T;
        }
        return { data: refunds, has_more: false } as T;
      },
    };

    await expect(verifyRefund("act_123", 0, client)).resolves.toMatchObject({
      verified: false,
      reason: "invalid_expected_amount",
    });
    await expect(verifyRefund("act_123", 41_200, client)).resolves.toEqual({
      verified: false,
      refunded_amount: 0,
      reason: "refund_missing",
    });
    refunds = [{ id: "re_pending", amount: 41_200, status: "pending" }];
    await expect(verifyRefund("act_123", 41_200, client)).resolves.toMatchObject({
      verified: false,
      reason: "refund_pending",
    });
    refunds = [{ id: "re_zero", amount: 0, status: "succeeded" }];
    await expect(verifyRefund("act_123", 41_200, client)).resolves.toEqual({
      verified: false,
      refunded_amount: 0,
      reason: "refund_zero",
    });
    refunds = [{ id: "re_succeeded", amount: 35_020, status: "succeeded" }];
    await expect(verifyRefund("act_123", 41_200, client)).resolves.toEqual({
      verified: false,
      refunded_amount: 35_020,
      reason: "amount_mismatch",
    });
  });

  it("accepts only the exact succeeded refund amount", async () => {
    const client: StripeRequester = {
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/v1/payment_intents/search") {
          return { data: [{ id: "pi_123", metadata: { action_id: "act_123" } }], has_more: false } as T;
        }
        return { data: [{ id: "re_ok", amount: 30_000, status: "succeeded" }], has_more: false } as T;
      },
    };
    expect(await verifyRefund("act_123", 30_000, client)).toEqual({
      verified: true,
      refunded_amount: 30_000,
      reason: "verified",
    });
    expect(await verifyRefundAmount("pi_123", 41_200, client)).toEqual({
      verified: false,
      refunded_amount: 30_000,
      reason: "amount_mismatch",
    });
  });
});

describe("dispute evidence", () => {
  it("fills every demo-chain evidence field", () => {
    const demoOrder: Action = {
      action_id: "act_transfer_3",
      task_id: "task_demo",
      merchant: "transfer",
      category: "transfer",
      summary: "Airport transfer, Nov 3",
      amount: 18_800,
      dates: { start: "2026-11-03" },
      ref: "TRANSFER-003",
      source: "email",
      received_at: "2026-11-01T14:05:02.000Z",
      state: "found",
    };
    const intent: Intent = {
      task_id: "task_demo",
      task_email: "task-demo@inkboxmail.com",
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
      action_id: demoOrder.action_id,
      field: "dates",
      expected: "2026-11-13",
      actual: "2026-11-03",
      evidence: {
        source_action_id: demoOrder.action_id,
        receipt_fields: { pickup_date: "2026-11-03", reservation_number: demoOrder.ref },
      },
    };
    const packet = buildDisputePacket({
      intent,
      order: demoOrder,
      confirmation_excerpt: "Transfer confirmation TRANSFER-003 for Nov 3.",
      stripe_charge_id: "ch_transfer_003",
      mismatch,
      why_wrong: "The order is for Nov 3, but the anchored intent requires Nov 13.",
      message_timeline: [
        {
          at: "2026-11-01T14:05:00.000Z",
          from: "proxy@demo.example",
          to: "support@metrotransfer.example",
          body: "Cancel transfer TRANSFER-003 and refund the charge.",
        },
        {
          at: "2026-11-01T14:10:00.000Z",
          from: "support@metrotransfer.example",
          to: "proxy@demo.example",
          body: "Cancellation was denied.",
        },
      ],
      deadline: "2026-11-01T18:00:00.000Z",
    });
    const evidence = buildDisputeEvidence(packet);
    const audit = JSON.parse(evidence.uncategorized_text) as Record<string, unknown>;

    expect(packet.order).toEqual(demoOrder);
    expect(packet.intent).toEqual(intent);
    expect(packet.mismatch).toEqual(mismatch);
    expect(packet.mismatch.evidence).toBeDefined();
    expect(packet.message_timeline).toHaveLength(2);
    expect(packet.deadline).toBeTruthy();
    expect(Object.values(evidence).every((value) => value !== undefined && value !== "")).toBe(true);
    expect(audit).toMatchObject({
      order: demoOrder,
      intent,
      mismatch,
      message_timeline: packet.message_timeline,
      deadline: packet.deadline,
    });
    expect(evidence.customer_communication).toContain("Cancellation was denied.");
  });
});
