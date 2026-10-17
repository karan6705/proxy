// In-memory MerchantDeps so every merchant works on its own with fake data (tests, local dev, evals).
// Behaves like Stripe where it matters: the same idempotency key returns the same charge.
// There is no refund here: merchants never refund. They return the refund they agreed to, and the orchestrator
// issues and verifies it through Payments.

import type { Cents } from "../types.js";
import type { ChargeArgs, MerchantDeps, MerchantEmail } from "./deps.js";

export interface FakeCharge {
  charge_id: string;
  amount: Cents;
  args: ChargeArgs;
}

export interface FakeDeps {
  deps: MerchantDeps;
  charges: FakeCharge[];
  emails: MerchantEmail[];
  /** Flip these to make the matching dependency fail. */
  failures: { charge: boolean; deliver: boolean };
}

export function createFakeDeps(): FakeDeps {
  const charges: FakeCharge[] = [];
  const emails: MerchantEmail[] = [];
  const failures = { charge: false, deliver: false };
  const chargeByKey = new Map<string, FakeCharge>();

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

    async deliver(email) {
      if (failures.deliver) {
        throw new Error("fake email delivery failure");
      }
      emails.push(email);
    },
  };

  return { deps, charges, emails, failures };
}
