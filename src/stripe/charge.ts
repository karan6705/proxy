import type { Action } from "../types.js";
import { rememberChargeForAction } from "./charge-links.js";
import { getStripeClient, type StripeRequester } from "./client.js";

interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  latest_charge: string | { id: string } | null;
}

export interface TestChargeResult {
  payment_intent_id: string;
  charge_id: string;
  amount: number;
  status: string;
}

export async function createTestCharge(
  action: Action,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<TestChargeResult> {
  if (!idempotencyKey) throw new Error("An idempotency key is required to create a charge");
  if (!Number.isSafeInteger(action.amount) || action.amount <= 0) {
    throw new Error("Action amount must be a positive integer in cents");
  }

  const intent = await client.request<StripePaymentIntent>(
    "POST",
    "/v1/payment_intents",
    {
      amount: action.amount,
      currency: "usd",
      confirm: true,
      payment_method: "pm_card_visa",
      "payment_method_types[0]": "card",
      description: action.summary,
      "metadata[action_id]": action.action_id,
      "metadata[task_id]": action.task_id,
      "metadata[merchant]": action.merchant,
      "metadata[merchant_ref]": action.ref,
    },
    { idempotencyKey },
  );

  const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
  if (!chargeId) throw new Error(`Stripe PaymentIntent ${intent.id} did not produce a charge`);
  rememberChargeForAction(action.action_id, chargeId);

  return {
    payment_intent_id: intent.id,
    charge_id: chargeId,
    amount: intent.amount,
    status: intent.status,
  };
}
