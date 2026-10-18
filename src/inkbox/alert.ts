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

/**
 * The one text per chain, laid out for a phone: the mistake, the numbers, then the choice, each on its own line.
 * Kept under about 320 characters (two SMS segments).
 */
export function composeChainAlert(f: AlertFacts): string {
  const things = f.affected === 1 ? "1 thing" : `${f.affected} things`;
  const window = f.time_left_ms === null ? "No deadline known" : `Reversible for ${formatTimeLeft(f.time_left_ms)}`;
  const body = (what: string) => `Your agent ${what}.\n\n${things} affected · ${money(f.money_at_risk)} at risk\n${window}\n\nReply UNDO ALL, PICK or KEEP.`;
  const text = body(f.what_went_wrong);
  return text.length <= 320 ? text : body("made a mistake");
}

const NOUN: Record<string, string> = { flight: "Flight", hotel: "Hotel", transfer: "Transfer", saas: "Subscription", store: "Order", message: "Message" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One line of the PICK list: "Flight, Nov 3 · $412". Short enough for one line on a phone. */
export function pickLine(a: { category: string; amount: Cents; dates?: { start: string }; merchant?: string }): string {
  const noun = a.merchant === "host" ? "Host email" : NOUN[a.category] ?? a.category;
  const m = a.dates ? /^\d{4}-(\d{2})-(\d{2})/.exec(a.dates.start) : null;
  const when = m ? `, ${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : "";
  return `${noun}${when} · ${a.amount === 0 ? "no charge" : money(a.amount)}`;
}
