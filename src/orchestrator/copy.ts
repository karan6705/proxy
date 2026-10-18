// Every text Proxy sends the human is written here, so alerts and progress read the same way:
// human dates ("Nov 3"), windows from the (simulated) clock in days past 48 hours, and money as
// "$828 at risk of $1,240" once part of a chain is undone.
import type { Action, Cents, Chain, DateRange, Intent, MerchantProtocolMessage, Mismatch, ProxyProtocolMessage } from "../types.js";

/** What refunds are confirmed in: "Stripe", or "Stripe (simulated)" where payments are simulated (the sandbox, the offline recording). */
export const DEFAULT_PAYMENTS_NAME = "Stripe";

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
  if (mismatch.field === "term") return `signed up for the ${String(mismatch.actual)} plan, not ${String(mismatch.expected)}`;
  const field = mismatch.field === "dates" ? "dates" : mismatch.field;
  return `used the wrong ${field} (${humanDate(mismatch.actual)}, not ${humanDate(mismatch.expected)})`;
}

/** Actions the agent already undid itself during its session, e.g. the flight. */
export interface AlreadyUndone {
  action: Pick<Action, "category" | "merchant">;
  amount: Cents;
}

export interface AlertCopy {
  already?: AlreadyUndone[];
  mismatch: Mismatch | undefined;
  affected: number;
  at_risk: Cents;
  total: Cents;
  /** Ms left in the tightest window on the clock Proxy runs on; null when there is none. */
  time_left_ms: number | null;
}

/**
 * The one text per chain, laid out for a phone like Sarah's composeChainAlert: the mistake (and what the agent
 * already undid), a blank line, the numbers on their own lines, a blank line, the choice. Under 320 characters.
 */
export function chainAlert(a: AlertCopy): string {
  const more = a.already?.length ? " more" : "";
  const things = a.affected === 1 ? `1${more} thing` : `${a.affected}${more} things`;
  const window = a.time_left_ms === null ? "No deadline known" : a.time_left_ms <= 0 ? "The window has closed" : `Reversible for ${timeLeft(a.time_left_ms)}`;
  const already = (a.already ?? []).map((d) => `\n${noun(d.action)} already refunded by your agent (${money(d.amount)}).`).join("");
  const body = (what: string) => `Your agent ${what}.${already}\n\n${things} affected · ${atRisk(a.at_risk, a.total)}\n${window}\n\nReply UNDO ALL, PICK or KEEP.`;
  const text = body(whatWentWrong(a.mismatch));
  return text.length <= 320 ? text : body("made a mistake");
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
export function refundedStep(a: Pick<Action, "category" | "merchant" | "amount">, refunded: Cents, via: string = DEFAULT_PAYMENTS_NAME): string {
  const amount = refunded < a.amount ? `${money(refunded)} of ${money(a.amount)}` : money(refunded);
  return `${noun(a)} refunded, ${amount}, confirmed in ${via}.`;
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
  /** Kept by the plan (fixing it costs more than it recovers), not by the human: still listed as open. */
  still_open?: boolean;
}

/**
 * The final text for a chain. Open items name their next option in the same text. `untouched` are actions
 * the human didn't pick: they are left as they are, not reported as failures.
 */
export function chainSummary(
  lines: SummaryLine[],
  redoDates: { start: string; end?: string } | undefined,
  untouched: Pick<Action, "category" | "merchant">[] = [],
  already: AlreadyUndone[] = [],
  via: string = DEFAULT_PAYMENTS_NAME,
): string {
  const back = lines.reduce((s, l) => s + (l.action.state === "verified" ? l.refunded : 0), 0);
  const total = lines.reduce((s, l) => s + l.action.amount, 0);
  const open = lines.filter((l) => l.still_open || !["verified", "accepted", "kept"].includes(l.action.state));
  const corrected = lines.filter((l) => l.action.state === "accepted" && l.action.amount === 0).map((l) => noun(l.action));
  const byAgent = already.length ? ` (${already.map((d) => `${noun(d.action).toLowerCase()} ${money(d.amount)} refunded by your agent`).join(", ")})` : "";
  const parts = [`${money(back)} of ${money(total)} back, confirmed in ${via}${byAgent}.`];
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

// --- the demo feed's lines ---

const pct = (part: Cents, whole: Cents) => (whole > 0 ? Math.round((part * 100) / whole) : 0);

/** A merchant agent's answer as one line, from typed fields only (a deny's free-text reason is never shown). */
export function merchantLine(who: string, m: MerchantProtocolMessage, orderAmount: Cents): string {
  if (m.type === "accept") return m.refund_amount > 0 ? `${who}: confirmed, refunding ${money(m.refund_amount)}.` : `${who}: confirmed, as store credit.`;
  if (m.type === "deny") return `${who}: declined to refund.`;
  if (m.kind === "store_credit") return `${who}: we can offer store credit of ${money(m.amount)}.`;
  if (m.kind === "partial_refund") return `${who}: we can refund ${pct(m.amount, orderAmount)}%, ${money(m.amount)}.`;
  return `${who}: we can move the booking to other dates instead.`;
}

/** One of Proxy's protocol messages as one line. `lastCounter` explains a push back. */
export function proxyLine(
  m: ProxyProtocolMessage,
  ctx: { summary: string; amount: Cents; lastCounter: { kind: string; amount: Cents } | null; minPct: number; mismatch?: Mismatch },
): string {
  if (m.type === "request_reversal") {
    const why = ctx.mismatch ? ` for the wrong ${ctx.mismatch.field} (${humanDate(ctx.mismatch.actual)}, not ${humanDate(ctx.mismatch.expected)})` : " by mistake";
    return `Proxy: our agent booked ${ctx.summary}${why}. Please cancel it and refund ${money(ctx.amount)}.`;
  }
  if (m.type === "push_back") {
    if (ctx.lastCounter?.kind === "store_credit") return "Proxy: our human doesn't accept store credit; requesting a refund.";
    return `Proxy: that's below our human's minimum of ${ctx.minPct}%; requesting a better refund.`;
  }
  if (m.type === "accept_counter") return `Proxy: we accept${ctx.lastCounter ? ` the ${money(ctx.lastCounter.amount)} ${ctx.lastCounter.kind === "store_credit" ? "store credit" : "refund"}` : " your offer"}.`;
  return "Proxy: checking with our human.";
}

/** A short title for an action, e.g. "Hotel · Harborview Hotel · Nov 3 to Nov 6" or "Email to Alex Rivera (host) · Nov 3". */
export function actionLabel(a: Pick<Action, "category" | "dates">, merchantName: string): string {
  const d = a.dates ? `${humanDate(a.dates.start)}${a.dates.end ? ` to ${humanDate(a.dates.end)}` : ""}` : "";
  const what = a.category === "message" ? `Email to ${merchantName}` : `${a.category[0]!.toUpperCase()}${a.category.slice(1)} · ${merchantName}`;
  return [what, d].filter(Boolean).join(" · ");
}
