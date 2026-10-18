// The only way the orchestrator refunds money. Every route (self-serve, protocol, email support,
// dispute follow-up) must call refundOnce, so an action can be refunded at most once:
// - one idempotency key per action, whatever the route, so concurrent or retried calls collapse in Stripe;
// - before refunding, Stripe is asked whether a succeeded refund already exists for the charge,
//   because Stripe forgets idempotency keys after 24 hours.
import type { Action, ActionId, Cents, Chain, Payments } from "../types.js";

/** One key per action and charge: a demo reset can reuse an action id, but never with the same charge. */
export function refundKey(action_id: ActionId, charge_id: string): string {
  return `refund:${action_id}:${charge_id}`;
}

export type RefundOnceResult =
  | { status: "no_charge" }
  | {
      status: "refunded" | "already_refunded";
      charge_id: string;
      refund_id: string | null;
      /** True only when Stripe shows at least `amount` refunded. */
      verified: boolean;
      refunded_amount: Cents;
    };

export async function refundOnce(
  payments: Pick<Payments, "findChargeForAction" | "refund" | "verifyRefund">,
  action: Action,
  amount: Cents,
): Promise<RefundOnceResult> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Expected refund amount must be a positive integer in cents");
  }
  const charge_id = await payments.findChargeForAction(action);
  if (charge_id === null) return { status: "no_charge" };

  const before = await payments.verifyRefund(charge_id, amount);
  if (before.refunded_amount > 0) {
    // Money already went back for this charge: never send a second refund, only report what Stripe shows.
    return {
      status: "already_refunded",
      charge_id,
      refund_id: null,
      verified: before.verified && before.refunded_amount === amount,
      refunded_amount: before.refunded_amount,
    };
  }

  const { refund_id } = await payments.refund(charge_id, amount, refundKey(action.action_id, charge_id));
  const after = await payments.verifyRefund(charge_id, amount);
  return {
    status: "refunded",
    charge_id,
    refund_id,
    verified: after.verified && after.refunded_amount === amount,
    refunded_amount: after.refunded_amount,
  };
}

/** The refund an action is owed: the amount agreed in its plan step (an accepted counter), else the full amount. */
export function expectedRefund(chain: Pick<Chain, "plan">, action: Pick<Action, "action_id" | "amount">): Cents {
  return chain.plan.find((s) => s.action_id === action.action_id)?.refund_amount ?? action.amount;
}
