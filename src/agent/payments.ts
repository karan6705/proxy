import type { Action, Cents, EvidencePacket, Payments } from "../types.js";
import { createTestCharge } from "../stripe/charge.js";
import { createPayments } from "../stripe/index.js";

export interface AgentPayments extends Payments {
  charge(action: Action, idempotencyKey: string): Promise<{ charge_id: string }>;
}

export function createStripeAgentPayments(): AgentPayments {
  const payments = createPayments();
  return {
    ...payments,
    async charge(action, idempotencyKey) {
      const result = await createTestCharge(action, idempotencyKey);
      return { charge_id: result.charge_id };
    },
  };
}

interface MockCharge {
  action_id: string;
  amount: Cents;
  refunded: Cents;
}

export function createMockAgentPayments(): AgentPayments & { readonly charges: ReadonlyMap<string, MockCharge> } {
  const charges = new Map<string, MockCharge>();
  const chargesByKey = new Map<string, string>();
  const refundsByKey = new Map<string, string>();
  let chargeSequence = 0;
  let refundSequence = 0;

  return {
    charges,
    async charge(action, idempotencyKey) {
      const existing = chargesByKey.get(idempotencyKey);
      if (existing) return { charge_id: existing };
      chargeSequence += 1;
      const chargeId = `ch_mock_${chargeSequence}`;
      chargesByKey.set(idempotencyKey, chargeId);
      charges.set(chargeId, { action_id: action.action_id, amount: action.amount, refunded: 0 });
      return { charge_id: chargeId };
    },
    async refund(chargeId, amount, idempotencyKey) {
      const existing = refundsByKey.get(idempotencyKey);
      if (existing) return { refund_id: existing };
      const charge = charges.get(chargeId);
      if (!charge) throw new Error(`Unknown mock charge ${chargeId}`);
      if (charge.refunded + amount > charge.amount) throw new Error(`Refund exceeds charge ${chargeId}`);
      refundSequence += 1;
      const refundId = `re_mock_${refundSequence}`;
      charge.refunded += amount;
      refundsByKey.set(idempotencyKey, refundId);
      return { refund_id: refundId };
    },
    async verifyRefund(chargeId, amount) {
      const refundedAmount = charges.get(chargeId)?.refunded ?? 0;
      return { verified: refundedAmount >= amount, refunded_amount: refundedAmount };
    },
    async createDispute(_chargeId: string, evidence: EvidencePacket) {
      return { dispute_id: `dp_mock_${evidence.order.action_id}` };
    },
    async findChargeForAction(action) {
      for (const [chargeId, charge] of charges) {
        if (charge.action_id === action.action_id) return chargeId;
      }
      return null;
    },
  };
}

export function createDemoPayments(env: NodeJS.ProcessEnv = process.env): AgentPayments {
  return env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? createStripeAgentPayments() : createMockAgentPayments();
}
