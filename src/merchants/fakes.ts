// In-memory MerchantDeps so every merchant works on its own with fake data (tests, local dev, evals).
// Behaves like Stripe where it matters: the same idempotency key returns the same charge or refund,
// and you cannot refund more than was charged.

import type { Cents } from "../types.js";
import type { ChargeArgs, MerchantDeps, MerchantEmail } from "./deps.js";

export interface FakeCharge {
  charge_id: string;
  amount: Cents;
  args: ChargeArgs;
}

export interface FakeRefund {
  refund_id: string;
  charge_id: string;
  amount: Cents;
  idempotency_key: string;
}

export interface FakeDeps {
  deps: MerchantDeps;
  charges: FakeCharge[];
  refunds: FakeRefund[];
  emails: MerchantEmail[];
  /** Flip these to make the matching dependency fail. */
  failures: { charge: boolean; refund: boolean; deliver: boolean };
}

export function createFakeDeps(): FakeDeps {
  const charges: FakeCharge[] = [];
  const refunds: FakeRefund[] = [];
  const emails: MerchantEmail[] = [];
  const failures = { charge: false, refund: false, deliver: false };
  const chargeByKey = new Map<string, FakeCharge>();
  const refundByKey = new Map<string, FakeRefund>();

  const deps: MerchantDeps = {
    async charge(args) {
      if (failures.charge) {
        throw new Error("fake Stripe charge failure");
      }
      const existing = chargeByKey.get(args.idempotency_key);
      if (existing) {
        return { charge_id: existing.charge_id };
      }
      const charge: FakeCharge = { charge_id: `ch_test_${charges.length + 1}`, amount: args.amount, args };
      charges.push(charge);
      chargeByKey.set(args.idempotency_key, charge);
      return { charge_id: charge.charge_id };
    },

    async refund(charge_id, amount, idempotency_key) {
      if (failures.refund) {
        throw new Error("fake Stripe refund failure");
      }
      const existing = refundByKey.get(idempotency_key);
      if (existing) {
        return { refund_id: existing.refund_id };
      }
      const charge = charges.find((c) => c.charge_id === charge_id);
      if (!charge) {
        throw new Error(`No such charge: ${charge_id}`);
      }
      const alreadyRefunded = refunds.filter((r) => r.charge_id === charge_id).reduce((sum, r) => sum + r.amount, 0);
      if (alreadyRefunded + amount > charge.amount) {
        throw new Error(`Refund of ${amount} exceeds the remaining ${charge.amount - alreadyRefunded} on ${charge_id}`);
      }
      const refund: FakeRefund = { refund_id: `re_test_${refunds.length + 1}`, charge_id, amount, idempotency_key };
      refunds.push(refund);
      refundByKey.set(idempotency_key, refund);
      return { refund_id: refund.refund_id };
    },

    async deliver(email) {
      if (failures.deliver) {
        throw new Error("fake email delivery failure");
      }
      emails.push(email);
    },
  };

  return { deps, charges, refunds, emails, failures };
}
