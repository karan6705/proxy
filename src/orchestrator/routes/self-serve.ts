// Self-serve route: a rule-based cancel with the merchant (e.g. the airline's 24-hour rule),
// then a Stripe refund, then verification. The action is "verified" only when Stripe shows the refund.
import type { Action, Chain, Clock, Merchants, Payments, Step, StepOutcome, Store } from "../../types.js";
import { refundOnce } from "../refunds.js";

export interface SelfServeDeps {
  merchants: Pick<Merchants, "selfServeCancel">;
  payments: Pick<Payments, "findChargeForAction" | "refund" | "verifyRefund">;
  store: Pick<Store, "upsertAction" | "appendStep">;
  clock: Clock;
}

export interface SelfServeResult {
  action: Action;
  step: Step;
}

export async function runSelfServeRoute(deps: SelfServeDeps, chain: Chain, action: Action): Promise<SelfServeResult> {
  const { merchants, payments, store, clock } = deps;

  const finish = async (
    state: Action["state"],
    outcome: StepOutcome,
    message: string,
    stripe_ref: string | null,
  ): Promise<SelfServeResult> => {
    const updated = await store.upsertAction({ ...action, state });
    const step: Step = {
      chain_id: chain.chain_id,
      action_id: action.action_id,
      route: "self_serve",
      protocol_state: null,
      round: 0,
      message,
      outcome,
      stripe_ref,
      at: clock.now(),
    };
    await store.appendStep(step);
    return { action: updated, step };
  };

  await store.upsertAction({ ...action, state: "requested" });

  const cancel = await merchants.selfServeCancel(action.merchant, action.ref, clock.now());
  if (!cancel.ok) {
    return finish("failed", "failed", `Merchant refused self-serve cancel: ${cancel.reason ?? "no reason given"}`, null);
  }

  // refundOnce: one idempotency key per action and no refund if Stripe already shows one.
  const r = await refundOnce(payments, action, cancel.refund_amount);
  if (r.status === "no_charge") {
    return finish("failed", "failed", "Cancelled with the merchant, but no Stripe charge found for this action", null);
  }
  const ref = r.refund_id ?? r.charge_id;
  // "verified" only when verifyRefund says so; anything else waits as refund_pending.
  if (!r.verified) {
    return finish("refund_pending", "pending", `Refund requested; Stripe shows ${r.refunded_amount} of ${cancel.refund_amount} so far`, ref);
  }
  return finish("verified", "succeeded", `Refunded ${cancel.refund_amount}, verified in Stripe`, ref);
}
