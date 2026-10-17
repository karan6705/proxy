// The self-undo rule, used by both review (fixable_now) and undo (enforcement).
// The agent may undo an action itself only if it is its own flagged action, free to undo with a
// full refund, needs no negotiation, and its session is still active. Everything else waits for the human.
import type { Reversibility, RouteKind, Timestamp } from "../types.js";

export interface SelfUndoCheck {
  /** compare() flagged this action for the agent's own task. */
  flagged: boolean;
  route: RouteKind | null;
  reversibility: Reversibility;
  session_active: boolean;
  now: Timestamp;
}

export type SelfUndoVerdict =
  | { allowed: true }
  | { allowed: false; reason: "not_flagged" | "session_ended" | "not_self_serve" | "not_free_full_refund" | "window_closed" };

export function checkSelfUndo(c: SelfUndoCheck): SelfUndoVerdict {
  if (!c.flagged) return { allowed: false, reason: "not_flagged" };
  if (!c.session_active) return { allowed: false, reason: "session_ended" };
  // Protocol, email support and disputes all involve the merchant or a negotiation.
  if (c.route !== "self_serve") return { allowed: false, reason: "not_self_serve" };
  const r = c.reversibility;
  if (r.kind !== "cancel_refund" || !r.refundable || r.cost_to_reverse !== 0) {
    return { allowed: false, reason: "not_free_full_refund" };
  }
  if (r.window_ends_at !== null && Date.parse(c.now) >= Date.parse(r.window_ends_at)) {
    return { allowed: false, reason: "window_closed" };
  }
  return { allowed: true };
}
