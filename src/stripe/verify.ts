import type { ActionId, Cents } from "../types.js";
import { getStripeClient, type StripeRequester } from "./client.js";

interface StripePaymentIntent {
  id: string;
  metadata?: Record<string, string>;
  latest_charge?: string | { id: string } | null;
}

interface StripeRefund {
  id: string;
  amount: number;
  status: string | null;
}

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

export type RefundVerificationReason =
  | "verified"
  | "invalid_expected_amount"
  | "payment_not_found"
  | "refund_missing"
  | "refund_pending"
  | "refund_zero"
  | "amount_mismatch";

export interface RefundVerification {
  verified: boolean;
  refunded_amount: Cents;
  reason: RefundVerificationReason;
}

function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function verifyTargetRefund(
  target: { charge?: string; payment_intent?: string },
  expectedAmount: Cents,
  client: StripeRequester,
): Promise<RefundVerification> {
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0) {
    return { verified: false, refunded_amount: 0, reason: "invalid_expected_amount" };
  }
  const refunds = await client.request<StripeList<StripeRefund>>("GET", "/v1/refunds", {
    charge: target.charge,
    payment_intent: target.payment_intent,
    limit: 100,
  });
  if (refunds.data.length === 0) return { verified: false, refunded_amount: 0, reason: "refund_missing" };
  const succeeded = refunds.data.filter((item) => item.status === "succeeded");
  if (succeeded.length === 0) return { verified: false, refunded_amount: 0, reason: "refund_pending" };
  const refundedAmount = succeeded.reduce((sum, item) => sum + item.amount, 0);
  if (refundedAmount <= 0) return { verified: false, refunded_amount: refundedAmount, reason: "refund_zero" };
  if (refundedAmount !== expectedAmount) {
    return { verified: false, refunded_amount: refundedAmount, reason: "amount_mismatch" };
  }
  return { verified: true, refunded_amount: refundedAmount, reason: "verified" };
}

async function findPaymentIntentsForAction(actionId: ActionId, client: StripeRequester): Promise<StripePaymentIntent[]> {
  const query = `metadata['action_id']:'${escapeSearchValue(actionId)}'`;
  const matches = await client.request<StripeList<StripePaymentIntent>>("GET", "/v1/payment_intents/search", {
    query,
    limit: 100,
  });
  return matches.data.filter((intent) => intent.metadata?.action_id === actionId);
}

export async function findChargeForActionId(
  actionId: ActionId,
  client: StripeRequester = getStripeClient(),
): Promise<string | null> {
  const intents = await findPaymentIntentsForAction(actionId, client);
  for (const intent of intents) {
    const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
    if (chargeId) return chargeId;
  }
  return null;
}

/** Money-truth check for an action. Merchant messages never affect this result. */
export async function verifyRefund(
  actionId: ActionId,
  expectedAmount: Cents,
  client: StripeRequester = getStripeClient(),
): Promise<RefundVerification> {
  const intents = await findPaymentIntentsForAction(actionId, client);
  if (intents.length === 0) return { verified: false, refunded_amount: 0, reason: "payment_not_found" };
  for (const intent of intents) {
    const result = await verifyTargetRefund({ payment_intent: intent.id }, expectedAmount, client);
    if (result.verified) return result;
    if (result.reason !== "refund_missing") return result;
  }
  return { verified: false, refunded_amount: 0, reason: "refund_missing" };
}

/** Amount-aware form used by the frozen Payments interface. */
export async function verifyRefundAmount(
  chargeOrPaymentIntentId: string,
  amount: Cents,
  client: StripeRequester = getStripeClient(),
): Promise<RefundVerification> {
  const target = chargeOrPaymentIntentId.startsWith("pi_")
    ? { payment_intent: chargeOrPaymentIntentId }
    : { charge: chargeOrPaymentIntentId };
  return verifyTargetRefund(target, amount, client);
}
