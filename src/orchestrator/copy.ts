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
export function whatWentWrong(mismatch: Mismatch | undefined, meant = false): string {
  if (!mismatch) return "made a mistake";
  if (meant && mismatch.field === "dates") return `booked ${humanDate(mismatch.actual)}, but you meant ${humanDate(mismatch.expected)}`;
  if (mismatch.field === "term") return `signed up for the ${String(mismatch.actual)} plan, not ${String(mismatch.expected)}`;
  if (mismatch.field === "item") return `ordered the wrong item (${String(mismatch.actual)}, not ${String(mismatch.expected)})`;
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
  /** The human just answered which date they meant: the alert says so ("booked Nov 3, but you meant Mar 11"). */
  meant?: boolean;
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
  // What the agent already fixed itself comes first, then what still needs the human.
  const fixed = (a.already ?? []).map((d) => `the ${noun(d.action).toLowerCase()} (${money(d.amount)})`);
  const already = fixed.length ? `\nYour agent already fixed ${fixed.join(" and ")}. ${a.affected === 1 ? "1 more thing needs" : `${a.affected} more things need`} you.` : "";
  const numbers = fixed.length ? atRisk(a.at_risk, a.total) : `${things} affected · ${atRisk(a.at_risk, a.total)}`;
  const body = (what: string) => `Your agent ${what}.${already}\n\n${numbers}\n${window}\n\nReply UNDO ALL, PICK or KEEP.`;
  const text = body(whatWentWrong(a.mismatch, a.meant));
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

/** Who undid a step and how, for every refund text: "Proxy negotiated with the hotel's agent", "Proxy emailed Metro Transfer Co. support". */
export function howUndone(a: Pick<Action, "category" | "merchant">, route: string, merchantName: string, byAgent = false): string {
  if (byAgent) return "Your agent cancelled it itself";
  if (route === "reversal_protocol") return `Proxy negotiated with the ${noun(a).toLowerCase()}'s agent`;
  if (route === "email_support") return `Proxy emailed ${merchantName} support`;
  if (route === "self_serve") return `Proxy cancelled it on ${merchantName}'s site`;
  return "Proxy";
}

/** One step confirmed, saying who did it and how: "Proxy emailed Metro Transfer Co. support. Transfer refunded, $188, confirmed in Stripe." */
export function refundedStep(a: Pick<Action, "category" | "merchant" | "amount">, refunded: Cents, via: string = DEFAULT_PAYMENTS_NAME, how?: string): string {
  const amount = refunded < a.amount ? `${money(refunded)} of ${money(a.amount)}` : money(refunded);
  return `${how ? `${how}. ` : ""}${noun(a)} refunded, ${amount}, confirmed in ${via}.`;
}

/** "Proxy emailed Alex Rivera (host) the right dates: Nov 13 to Nov 16." */
export function correctionStep(a: Pick<Action, "category" | "merchant">, dates: { start: string; end?: string } | undefined, to?: string): string {
  const when = dates ? `: ${humanDate(dates.start)}${dates.end ? ` to ${humanDate(dates.end)}` : ""}` : "";
  return to ? `Proxy emailed ${to} the right dates${when}.` : `${noun(a)} correction sent${when}.`;
}

export function noAnswerYet(a: Pick<Action, "category" | "merchant">): string {
  return `The ${noun(a).toLowerCase()} hasn't answered, following up by email.`;
}

/** The watchdog's text when a chain has been undoing too long: what Proxy is still waiting on. */
export function stillWorking(open: Pick<Action, "category" | "merchant">[]): string {
  const names = open.map((a) => `the ${noun(a).toLowerCase()}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `Still working on ${list}. Everything else is settled. I'll text you as soon as it's done.`;
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
  /** Store credit the human chose for this action instead of money back. */
  credit?: Cents;
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
  // Store credit the human chose is shown as credit, never as money back.
  const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  const total = lines.reduce((s, l) => s + l.action.amount, 0);
  const open = lines.filter((l) => l.still_open || !["verified", "accepted", "kept"].includes(l.action.state));
  const corrected = lines.filter((l) => l.action.state === "accepted" && l.action.amount === 0).map((l) => noun(l.action));
  const byAgent = already.length ? ` (${already.map((d) => `${noun(d.action).toLowerCase()} ${money(d.amount)} refunded by your agent`).join(", ")})` : "";
  const parts = [`${money(back)} of ${money(total)} back, confirmed in ${via}${byAgent}${credit ? `, plus ${money(credit)} as store credit` : ""}.`];
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

/** One of a merchant's offers, as a line in Proxy's options text. */
export function optionLabel(o: { kind: string; amount: Cents }, orderAmount: Cents, merchantName: string): string {
  if (o.kind === "store_credit") return `${money(o.amount)} store credit at ${merchantName}`;
  if (o.kind === "partial_refund") return o.amount >= orderAmount ? `Full refund, ${money(o.amount)}, to your card` : `Refund ${money(o.amount)} (${pct(o.amount, orderAmount)}%) to your card`;
  return `Change the booking instead (${money(o.amount)})`;
}

/**
 * The question Proxy asks before accepting any merchant offer: every distinct offer, numbered, and its recommendation
 * from the human's rules. "Harborview Hotel's best offer: 1) Refund $544 (85%) to your card 2) $640 store credit ...
 * Your rules prefer refunds, so I recommend 1. Reply 1 or 2."
 */
export function offerOptionsText(
  merchantName: string,
  options: { kind: string; amount: Cents }[],
  orderAmount: Cents,
  recommended: number | null,
  prefs: { no_store_credit: boolean; min_partial_refund_pct: number },
  canPush: boolean,
): string {
  const lines = options.map((o, i) => `${i + 1}) ${optionLabel(o, orderAmount, merchantName)}`).join("\n");
  const rec = recommended === null ? null : options[recommended];
  const why = !rec
    ? `None of these meets your rules (${prefs.no_store_credit ? "no store credit, " : ""}at least ${prefs.min_partial_refund_pct}% back).`
    : rec.kind === "store_credit"
      ? `Your rules allow store credit, so I recommend ${recommended! + 1}.`
      : prefs.no_store_credit
        ? `Your rules prefer refunds, so I recommend ${recommended! + 1}.`
        : `It meets your ${prefs.min_partial_refund_pct}% minimum, so I recommend ${recommended! + 1}.`;
  const nums = options.map((_, i) => String(i + 1));
  const pick = nums.length === 1 ? "Reply 1" : `Reply ${nums.slice(0, -1).join(", ")} or ${nums.at(-1)}`;
  return `${merchantName}'s best offer:\n${lines}\n${why} ${pick}${canPush ? ", or KEEP PUSHING" : ""}.`;
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

/** What Proxy knows when it writes one of its protocol messages. Typed state only: never merchant text. */
export interface ProxyLineContext {
  summary: string;
  amount: Cents;
  /** The merchant's offer Proxy is answering (its last counter). */
  lastCounter: { kind: string; amount: Cents } | null;
  minPct: number;
  mismatch?: Mismatch;
  /** The booking reference, e.g. HTL-F1KEY5. */
  ref?: string;
  /** The human's rule against store credit. */
  noStoreCredit?: boolean;
  /** Ms until the booking's window closes on Proxy's clock; null when unknown. */
  timeLeftMs?: number | null;
  /** The dates the agent will rebook, e.g. "Nov 13 to Nov 16", for the anchor. */
  rebook?: string;
  /** This push back is the human's KEEP PUSHING. */
  byHuman?: boolean;
}

/** Which of its decisions a push back is: the store-credit rule, the anchor for the full amount, or a low offer. */
export function pushBackKind(ctx: Pick<ProxyLineContext, "lastCounter" | "minPct" | "amount">): "store_credit" | "anchor" | "below_minimum" {
  if (ctx.lastCounter?.kind === "store_credit") return "store_credit";
  return ctx.lastCounter && ctx.lastCounter.amount * 100 >= ctx.minPct * ctx.amount ? "anchor" : "below_minimum";
}

/** One of Proxy's protocol messages as one line, the way it says it to the merchant. */
export function proxyLine(m: ProxyProtocolMessage, ctx: ProxyLineContext): string {
  const offerPct = ctx.lastCounter ? pct(ctx.lastCounter.amount, ctx.amount) : 0;
  if (m.type === "request_reversal") {
    if (ctx.mismatch?.field === "item") {
      return `Proxy: our agent ordered the wrong item (${String(ctx.mismatch.actual)}, not ${String(ctx.mismatch.expected)}), and we caught it right away. Please cancel ${ctx.ref ?? "the order"} and refund the full ${money(ctx.amount)}. Attached: the original request, your receipt and the timeline.`;
    }
    const why = ctx.mismatch ? ` for the wrong ${ctx.mismatch.field} (${humanDate(ctx.mismatch.actual)}, not ${humanDate(ctx.mismatch.expected)})` : " by mistake";
    return `Proxy: our agent booked ${ctx.summary}${why}, and we caught it within hours. Please cancel ${ctx.ref ?? "it"} and refund the full ${money(ctx.amount)}. Attached: the original request, your receipt and the timeline.`;
  }
  if (m.type === "push_back") {
    if (ctx.byHuman) return `Proxy: our customer asked us to push once more. Can you do better than ${ctx.lastCounter ? money(ctx.lastCounter.amount) : "that"}?`;
    const kind = pushBackKind(ctx);
    if (kind === "store_credit") return `Proxy: we can't take store credit; our human's rule is money back to the card. The error was our agent's, caught within hours. Please refund the ${money(ctx.amount)}.`;
    if (kind === "anchor") return `Proxy: thank you. We're rebooking with you${ctx.rebook ? ` for ${ctx.rebook}` : ""}, so we're asking for the full ${money(ctx.amount)} back on this booking.`;
    return `Proxy: ${offerPct}% is below our human's minimum of ${ctx.minPct}%. Please improve the offer.`;
  }
  if (m.type === "accept_counter") {
    if (ctx.lastCounter?.kind === "store_credit") return `Proxy: we accept the ${money(ctx.lastCounter.amount)} store credit.`;
    return `Proxy: accepted. We'll take the ${ctx.lastCounter ? money(ctx.lastCounter.amount) : "offered"} refund.`;
  }
  return "Proxy: checking with our human.";
}

/** Why Proxy made the decision its message carries, in the human's terms: "Declined: you don't accept store credit". */
export function proxyWhy(m: ProxyProtocolMessage, ctx: ProxyLineContext): string {
  const left = ctx.timeLeftMs === null || ctx.timeLeftMs === undefined ? "" : ctx.timeLeftMs > 0 ? `; ${timeLeft(ctx.timeLeftMs)} left` : "; the window has closed";
  const offerPct = ctx.lastCounter ? pct(ctx.lastCounter.amount, ctx.amount) : 0;
  if (m.type === "request_reversal") return `Asked for the full ${money(ctx.amount)} first, with the evidence${left}`;
  if (m.type === "push_back") {
    if (ctx.byHuman) return "Pushed once more: you replied KEEP PUSHING";
    const kind = pushBackKind(ctx);
    if (kind === "store_credit") return "Declined: you don't accept store credit";
    if (kind === "anchor") return `Asked once for the full amount: ${offerPct}% already meets your ${ctx.minPct}% minimum, and there is a round left${left}`;
    return `Declined: ${offerPct}% is below your ${ctx.minPct}% minimum`;
  }
  // Proxy accepts only what the human chose from its options.
  if (m.type === "accept_counter") {
    if (ctx.lastCounter?.kind === "store_credit") return "Accepted: you chose the store credit";
    return `Accepted: you chose it; ${offerPct}% meets your ${ctx.minPct}% minimum${left}`;
  }
  return "The human decides this one";
}

/**
 * A merchant agent's own one-line message, for display only: plain text, one line, at most 200 characters. It is
 * never acted on and never sent to the human; the typed fields (merchantLine) are what Proxy reads.
 */
export function merchantSaid(m: MerchantProtocolMessage): string | null {
  const raw = (m as unknown as { message?: unknown }).message;
  if (typeof raw !== "string") return null;
  const line = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return line || null;
}

/** A short title for an action, e.g. "Hotel · Harborview Hotel · Nov 3 to Nov 6" or "Email to Alex Rivera (host) · Nov 3". */
export function actionLabel(a: Pick<Action, "category" | "dates">, merchantName: string): string {
  const d = a.dates ? `${humanDate(a.dates.start)}${a.dates.end ? ` to ${humanDate(a.dates.end)}` : ""}` : "";
  const what = a.category === "message" ? `Email to ${merchantName}` : `${a.category[0]!.toUpperCase()}${a.category.slice(1)} · ${merchantName}`;
  return [what, d].filter(Boolean).join(" · ");
}
