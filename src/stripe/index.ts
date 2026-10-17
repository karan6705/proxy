import type { Payments } from "../types.js";
import { getStripeClient, type StripeRequester } from "./client.js";
import { createDispute as attachDisputeEvidence } from "./dispute.js";
import { refund } from "./refund.js";
import { findChargeForActionId, verifyRefundAmount } from "./verify.js";

export function createPayments(client: StripeRequester = getStripeClient()): Payments {
  return {
    refund(chargeId, amount, idempotencyKey) {
      return refund(chargeId, amount, idempotencyKey, client);
    },
    verifyRefund(chargeId, amount) {
      return verifyRefundAmount(chargeId, amount, client);
    },
    createDispute(chargeId, evidence) {
      const idempotencyKey = `dispute:${evidence.order.action_id}:${evidence.mismatch.field}`;
      return attachDisputeEvidence(chargeId, evidence, idempotencyKey, client);
    },
    findChargeForAction(action) {
      return findChargeForActionId(action.action_id, client);
    },
  };
}

export * from "./charge.js";
export * from "./client.js";
export * from "./dispute.js";
export * from "./refund.js";
export * from "./verify.js";
export * from "./webhook.js";
