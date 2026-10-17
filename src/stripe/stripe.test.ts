import { describe, expect, it } from "vitest";
import type { Action } from "../types.js";
import { createTestCharge } from "./charge.js";
import { StripeClient, type StripeRequester } from "./client.js";
import { verifyRefund, verifyRefundAmount } from "./verify.js";

const action: Action = {
  action_id: "act_123",
  task_id: "task_123",
  merchant: "airline",
  category: "flight",
  summary: "Test flight",
  amount: 41200,
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
