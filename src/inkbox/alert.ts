// The one text per chain. Kept under about 320 characters (two SMS segments).
import type { Cents } from "../types.js";

export interface AlertFacts {
  /** e.g. "used the wrong date (Nov 3, not Nov 13)" */
  what_went_wrong: string;
  affected: number;
  money_at_risk: Cents;
  /** Time left in the tightest window, in ms. Null when there is no window. */
  time_left_ms: number | null;
}

export const money = (c: Cents) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

export function formatTimeLeft(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function composeChainAlert(f: AlertFacts): string {
  const things = f.affected === 1 ? "1 thing" : `${f.affected} things`;
  const window = f.time_left_ms === null ? "No deadline known." : `Reversible for ${formatTimeLeft(f.time_left_ms)}.`;
  const text = `Your agent ${f.what_went_wrong}. ${things} affected, ${money(f.money_at_risk)} at risk. ${window} Reply UNDO ALL, PICK or KEEP.`;
  return text.length <= 320 ? text : `Your agent made a mistake. ${things} affected, ${money(f.money_at_risk)} at risk. ${window} Reply UNDO ALL, PICK or KEEP.`;
}
