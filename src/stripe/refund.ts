import type { Cents } from "../types.js";
import { getStripeClient, type StripeRequester } from "./client.js";

export interface StripeRefundResult {
  refund_id: string;
  amount: Cents;
  status: string;
}

interface StripeRefund {
  id: string;
  amount: number;
  status: string | null;
  metadata?: Record<string, string>;
}

interface StripeList<T> {
  data: T[];
}

const IDEMPOTENCY_METADATA_KEY = "proxy_idempotency_key";

function refundTarget(id: string): Record<string, string> {
  if (id.startsWith("pi_")) return { payment_intent: id };
  if (id.startsWith("ch_")) return { charge: id };
  throw new Error("Refund target must be a Stripe charge (ch_) or PaymentIntent (pi_)");
}

async function requestRefund(
  chargeOrPaymentIntentId: string,
  amount: Cents | undefined,
  idempotencyKey: string,
  client: StripeRequester,
): Promise<StripeRefundResult> {
  if (!idempotencyKey) throw new Error("An idempotency key is required to refund a charge");
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) {
    throw new Error("Partial refund amount must be a positive integer in cents");
  }

  const target = refundTarget(chargeOrPaymentIntentId);
  const refunds = await client.request<StripeList<StripeRefund>>("GET", "/v1/refunds", {
    ...target,
    limit: 100,
  });
  const existing = refunds.data.find(
    (item) => item.status === "succeeded" && item.metadata?.[IDEMPOTENCY_METADATA_KEY] === idempotencyKey,
  );
  if (existing) return { refund_id: existing.id, amount: existing.amount, status: "succeeded" };

  const result = await client.request<StripeRefund>(
    "POST",
    "/v1/refunds",
    { ...target, amount, [`metadata[${IDEMPOTENCY_METADATA_KEY}]`]: idempotencyKey },
    { idempotencyKey },
  );
  return { refund_id: result.id, amount: result.amount, status: result.status ?? "unknown" };
}

export function fullRefund(
  chargeOrPaymentIntentId: string,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<StripeRefundResult> {
  return requestRefund(chargeOrPaymentIntentId, undefined, idempotencyKey, client);
}

export function partialRefund(
  chargeOrPaymentIntentId: string,
  amount: Cents,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<StripeRefundResult> {
  return requestRefund(chargeOrPaymentIntentId, amount, idempotencyKey, client);
}

export async function refund(
  chargeOrPaymentIntentId: string,
  amount: Cents,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<{ refund_id: string }> {
  const result = await requestRefund(chargeOrPaymentIntentId, amount, idempotencyKey, client);
  return { refund_id: result.refund_id };
}
