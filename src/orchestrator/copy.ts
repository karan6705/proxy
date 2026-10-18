// Every text Proxy sends the human is written here, so alerts and progress read the same way:
// human dates ("Nov 3"), windows from the (simulated) clock in days past 48 hours, and money as
// "$828 at risk of $1,240" once part of a chain is undone.
import type { Action, Cents, Chain, DateRange, Intent, Mismatch } from "../types.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function money(c: Cents): string {
  const dollars = c / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** "2026-11-13" or a full ISO timestamp -> "Nov 13". Anything else is returned unchanged. */
export function humanDate(value: unknown): string {
  if (typeof value !== "string") return String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** Time left, e.g. "45m", "23h 59m", "3 days". */
export function timeLeft(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(mins / 60);
  if (h >= 48) {
    const days = Math.floor(h / 24);
    return `${days} days`;
  }
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** "$1,240 at risk", or "$828 at risk of $1,240" when part of the chain is already undone. */
export function atRisk(atRiskCents: Cents, totalCents: Cents): string {
  return atRiskCents < totalCents ? `${money(atRiskCents)} at risk of ${money(totalCents)}` : `${money(atRiskCents)} at risk`;
}

/** What went wrong, from the first mismatch: "used the wrong dates (Nov 3, not Nov 13)". */
export function whatWentWrong(mismatch: Mismatch | undefined): string {
  if (!mismatch) return "made a mistake";
  const field = mismatch.field === "dates" ? "dates" : mismatch.field;
  return `used the wrong ${field} (${humanDate(mismatch.actual)}, not ${humanDate(mismatch.expected)})`;
}

export interface AlertCopy {
  mismatch: Mismatch | undefined;
  affected: number;
  at_risk: Cents;
  total: Cents;
  /** Ms left in the tightest window on the clock Proxy runs on; null when there is none. */
  time_left_ms: number | null;
}

/** The one text per chain. Kept under 320 characters (two SMS segments). */
export function chainAlert(a: AlertCopy): string {
  const things = a.affected === 1 ? "1 thing" : `${a.affected} things`;
  const window = a.time_left_ms === null ? "No deadline known." : a.time_left_ms <= 0 ? "The window has closed." : `Reversible for ${timeLeft(a.time_left_ms)}.`;
  const text = `Your agent ${whatWentWrong(a.mismatch)}. ${things} affected, ${atRisk(a.at_risk, a.total)}. ${window} Reply UNDO ALL, PICK or KEEP.`;
  return text.length <= 320 ? text : `Your agent made a mistake. ${things} affected, ${atRisk(a.at_risk, a.total)}. ${window} Reply UNDO ALL, PICK or KEEP.`;
}

const NOUN: Record<Action["category"], string> = {
  flight: "Flight",
  hotel: "Hotel",
  transfer: "Transfer",
  saas: "Subscription",
  store: "Order",
  message: "Message",
};

export const noun = (a: Pick<Action, "category" | "merchant">) => (a.merchant === "host" ? "Host" : NOUN[a.category] ?? a.merchant);

/** One step confirmed: "Flight refunded, $412, confirmed in Stripe", or "Hotel refunded, $544 of $640, confirmed in Stripe". */
export function refundedStep(a: Pick<Action, "category" | "merchant" | "amount">, refunded: Cents): string {
  const amount = refunded < a.amount ? `${money(refunded)} of ${money(a.amount)}` : money(refunded);
  return `${noun(a)} refunded, ${amount}, confirmed in Stripe.`;
}

export function correctionStep(a: Pick<Action, "category" | "merchant">, dates: { start: string; end?: string } | undefined): string {
  return `${noun(a)} correction sent${dates ? `: ${humanDate(dates.start)}${dates.end ? ` to ${humanDate(dates.end)}` : ""}` : ""}.`;
}

export function noAnswerYet(a: Pick<Action, "category" | "merchant">): string {
  return `The ${noun(a).toLowerCase()} hasn't answered, following up by email.`;
}

export function deniedStep(a: Pick<Action, "category" | "merchant" | "amount">, next: string): string {
  return `The ${noun(a).toLowerCase()} refused to refund ${money(a.amount)}. ${next}`;
}

export interface SummaryLine {
  action: Pick<Action, "category" | "merchant" | "amount" | "state">;
  refunded: Cents;
  /** For an action still open: what the human can do next, e.g. "dispute the $640 charge with your card". */
  next?: string;
}

/**
 * The final text for a chain. Open items name their next option in the same text. `untouched` are actions
 * the human didn't pick: they are left as they are, not reported as failures.
 */
export function chainSummary(lines: SummaryLine[], redoDates: { start: string; end?: string } | undefined, untouched: Pick<Action, "category" | "merchant">[] = []): string {
  const back = lines.reduce((s, l) => s + (l.action.state === "verified" ? l.refunded : 0), 0);
  const total = lines.reduce((s, l) => s + l.action.amount, 0);
  const open = lines.filter((l) => !["verified", "accepted", "kept"].includes(l.action.state));
  const corrected = lines.filter((l) => l.action.state === "accepted" && l.action.amount === 0).map((l) => noun(l.action));
  const parts = [`${money(back)} of ${money(total)} back, confirmed in Stripe.`];
  if (corrected.length) parts.push(`${corrected.join(", ")} told the right dates.`);
  if (open.length) {
    parts.unshift("Partly done.");
    parts.push(`Still open: ${open.map((l) => `${noun(l.action)} (${l.next ?? `dispute the ${money(l.action.amount)} charge with your card`})`).join("; ")}. Reply KEEP to accept the rest.`);
  } else if (untouched.length) {
    parts.unshift("Done with what you picked.");
  } else {
    parts.unshift("All done.");
    if (redoDates) parts.push(`Your agent will rebook for ${humanDate(redoDates.start)}.`);
  }
  if (untouched.length) parts.push(`Left as is: ${untouched.map(noun).join(", ")}.`);
  return parts.join(" ");
}

/** What the human can still do about an action Proxy couldn't fix, from its plan step. */
export function nextOption(a: Pick<Action, "category" | "merchant" | "amount">, step: { option: string; cost: Cents } | undefined): string {
  if (a.amount === 0) return `send the ${noun(a).toLowerCase()} the right dates yourself`;
  if (step && step.option === "change" && step.cost > 0) return `change it with the ${a.merchant} for a ${money(step.cost)} fee`;
  return `dispute the ${money(a.amount)} charge with your card`;
}

/** Money still at risk in a chain: what isn't refunded, corrected or kept yet. */
export function chainMoney(chain: Pick<Chain, "action_ids">, actions: Action[]): { at_risk: Cents; total: Cents } {
  const mine = actions.filter((a) => chain.action_ids.includes(a.action_id));
  const total = mine.reduce((s, a) => s + a.amount, 0);
  const at_risk = mine.filter((a) => !["verified", "kept"].includes(a.state)).reduce((s, a) => s + a.amount, 0);
  return { at_risk, total };
}

const MONTH_INDEX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m.toLowerCase(), i]));

/**
 * Dates from a correction text such as "ugh no the 13th" or "Nov 13". The month and year default to the
 * intent's, and the trip keeps its length. Null when the text names no day.
 */
export function correctedDates(text: string, intent: Pick<Intent, "constraints">): DateRange | null {
  const current = intent.constraints.dates;
  const base = current?.start ? new Date(`${current.start}T00:00:00Z`) : null;
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(text);
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/i.exec(text) ?? /\bthe\s+(\d{1,2})\b/i.exec(text);
  const day = named ? Number(named[2]) : ordinal ? Number(ordinal[1]) : null;
  if (day === null || day < 1 || day > 31 || !base) return null;
  const month = named ? MONTH_INDEX[named[1]!.toLowerCase().slice(0, 3)]! : base.getUTCMonth();
  const start = new Date(Date.UTC(base.getUTCFullYear(), month, day));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (!current?.end) return { start: iso(start) };
  const length = Date.parse(`${current.end}T00:00:00Z`) - base.getTime();
  return { start: iso(start), end: iso(new Date(start.getTime() + length)) };
}
