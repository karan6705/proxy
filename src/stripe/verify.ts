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

function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listSucceededRefunds(
  target: { charge?: string; payment_intent?: string },
  client: StripeRequester,
): Promise<StripeRefund[]> {
  const refunds = await client.request<StripeList<StripeRefund>>("GET", "/v1/refunds", {
    charge: target.charge,
    payment_intent: target.payment_intent,
    limit: 100,
  });
  return refunds.data.filter((item) => item.status === "succeeded");
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
  client: StripeRequester = getStripeClient(),
): Promise<boolean> {
  const intents = await findPaymentIntentsForAction(actionId, client);
  for (const intent of intents) {
    const succeeded = await listSucceededRefunds({ payment_intent: intent.id }, client);
    if (succeeded.length > 0) return true;
  }
  return false;
}

/** Amount-aware form used by the frozen Payments interface. */
export async function verifyRefundAmount(
  chargeOrPaymentIntentId: string,
  amount: Cents,
  client: StripeRequester = getStripeClient(),
): Promise<{ verified: boolean; refunded_amount: Cents }> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Refund amount must be a non-negative integer in cents");
  const target = chargeOrPaymentIntentId.startsWith("pi_")
    ? { payment_intent: chargeOrPaymentIntentId }
    : { charge: chargeOrPaymentIntentId };
  const refunds = await listSucceededRefunds(target, client);
  const refundedAmount = refunds.reduce((sum, item) => sum + item.amount, 0);
  return { verified: refundedAmount >= amount, refunded_amount: refundedAmount };
}
