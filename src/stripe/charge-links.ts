import type { ActionId } from "../types.js";

// Immediate in-process lookup for newly created charges. Stripe Search is eventually consistent,
// so the undo path checks this before falling back to the API search endpoint.
const chargeByAction = new Map<ActionId, string>();

export function rememberChargeForAction(actionId: ActionId, chargeId: string): void {
  chargeByAction.set(actionId, chargeId);
}

export function linkedChargeForAction(actionId: ActionId): string | null {
  return chargeByAction.get(actionId) ?? null;
}
