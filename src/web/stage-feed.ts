// What the stage page (/web/stage) reads, and a fixture that tells the whole demo story step by step.
// GET /demo/feed?task_id=... is expected to return a StageFeed. Until it exists the page runs on
// GET /web/stage-fixture, which reveals the fixture one step at a time.
import type { ActionCategory, Cents, DateRange, Timestamp } from "../types.js";

export interface StageBooking {
  id: string;
  merchant: string;
  category: ActionCategory;
  summary: string;
  amount: Cents;
  dates?: DateRange;
  /** When the confirmation reached Proxy. */
  at: Timestamp;
  /** True when compare flagged it. If omitted, the page compares the dates with what the human asked for. */
  wrong?: boolean;
}

export interface StageRow {
  id: string;
  label: string;
  amount: Cents;
  /** Action state: found, requested, refund_pending, verified, accepted, failed, kept ... */
  state: string;
  /** Cents Stripe has confirmed back for this row. */
  refunded: Cents;
  /** True only when Stripe shows it. */
  verified: boolean;
}

export interface StageChain {
  chain_id: string;
  state: string;
  window_ends_at: Timestamp | null;
  /** Total of the whole chain, the "Y" in "Recovered $X of $Y". */
  total: Cents;
  /** Confirmed in Stripe so far, the "X". */
  recovered: Cents;
  rows: StageRow[];
}

export interface StageHumanEntry {
  at: Timestamp;
  direction: "out" | "in";
  channel: "imessage" | "sms" | "call";
  text: string;
}

export type StageEntryKind = "request" | "counter" | "push_back" | "accept_counter" | "accept" | "deny" | "email" | "reply" | "stripe" | "correction";

export interface StageConversationEntry {
  at: Timestamp;
  from: "proxy" | "merchant" | "stripe";
  kind: StageEntryKind;
  text: string;
}

export interface StageConversation {
  /** "hotel" or "transfer" (or any merchant id). */
  with: string;
  /** Shown on the bubbles, e.g. "Harborview Hotel agent". */
  name: string;
  entries: StageConversationEntry[];
}

export interface StageFeed {
  task_id: string;
  /** The run's clock, which the page ticks forward between polls. */
  now: Timestamp;
  task: { goal: string; intended_dates?: DateRange; budget_total?: Cents };
  bookings: StageBooking[];
  chain: StageChain | null;
  human: StageHumanEntry[];
  conversations: StageConversation[];
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture: the demo story. Each step adds one thing. Times are on the simulated demo clock.

const T0 = Date.parse("2026-10-18T05:25:00.000Z");
const at = (secs: number): Timestamp => new Date(T0 + secs * 1000).toISOString();

const TASK = {
  goal: "NYC trip for the Nov 13 conference, under $1,500",
  intended_dates: { start: "2026-11-13", end: "2026-11-16" },
  budget_total: 150000,
};

const BOOKINGS: StageBooking[] = [
  { id: "flight", merchant: "airline", category: "flight", summary: "Flight · SFO to JFK", amount: 41200, dates: { start: "2026-11-03" }, at: at(-20), wrong: true },
  { id: "hotel", merchant: "hotel", category: "hotel", summary: "Harborview Hotel · 3 nights", amount: 64000, dates: { start: "2026-11-03", end: "2026-11-06" }, at: at(-15), wrong: true },
  { id: "transfer", merchant: "transfer", category: "transfer", summary: "Airport transfer · JFK to hotel", amount: 18800, dates: { start: "2026-11-03" }, at: at(-10), wrong: true },
  { id: "host", merchant: "host", category: "message", summary: "Email to the host", amount: 0, dates: { start: "2026-11-03" }, at: at(-5), wrong: true },
];

const ROW_LABEL: Record<string, string> = { flight: "Flight", hotel: "Hotel", transfer: "Airport transfer", host: "Host email" };

interface Step {
  /** Short description, for rehearsal. */
  note: string;
  apply: (s: Draft) => void;
}

interface Draft {
  bookings: number;
  chain: boolean;
  states: Record<string, { state: string; refunded: Cents; verified: boolean }>;
  human: StageHumanEntry[];
  hotel: StageConversationEntry[];
  transfer: StageConversationEntry[];
  now: number;
}

const ALERT =
  "Your agent used the wrong date (Nov 3, not Nov 13).\n\n4 things affected · $1,240 at risk\nReversible for 3h 40m\n\nReply UNDO ALL, PICK or KEEP.";

export const FIXTURE_STEPS: Step[] = [
  { note: "flight booked", apply: (s) => void (s.bookings = 1) },
  { note: "hotel booked", apply: (s) => void (s.bookings = 2) },
  { note: "transfer booked", apply: (s) => void (s.bookings = 3) },
  { note: "host email sent", apply: (s) => void (s.bookings = 4) },
  {
    note: "chain opens, one text to the human",
    apply: (s) => {
      s.chain = true;
      s.human.push({ at: at(8), direction: "out", channel: "imessage", text: ALERT });
    },
  },
  { note: "human replies UNDO ALL", apply: (s) => void s.human.push({ at: at(20), direction: "in", channel: "imessage", text: "UNDO ALL" }) },
  {
    note: "flight refunded by the 24-hour rule, confirmed in Stripe",
    apply: (s) => void (s.states.flight = { state: "verified", refunded: 41200, verified: true }),
  },
  {
    note: "Proxy asks the hotel agent",
    apply: (s) => {
      s.states.hotel = { state: "requested", refunded: 0, verified: false };
      s.hotel.push({ at: at(24), from: "proxy", kind: "request", text: "Please reverse booking HTL-F1KEY5 ($640). The agent booked Nov 3 instead of Nov 13. Evidence attached." });
    },
  },
  { note: "hotel counters with store credit", apply: (s) => void s.hotel.push({ at: at(27), from: "merchant", kind: "counter", text: "We can offer $640 in store credit." }) },
  { note: "Proxy pushes back", apply: (s) => void s.hotel.push({ at: at(31), from: "proxy", kind: "push_back", text: "No store credit, please. This person's preferences exclude it." }) },
  { note: "hotel counters with 85%", apply: (s) => void s.hotel.push({ at: at(35), from: "merchant", kind: "counter", text: "Then a partial refund: 85%, $544." }) },
  { note: "Proxy accepts", apply: (s) => void s.hotel.push({ at: at(38), from: "proxy", kind: "accept_counter", text: "Accepted. 85% is within what this person allows." }) },
  { note: "hotel agrees", apply: (s) => void s.hotel.push({ at: at(41), from: "merchant", kind: "accept", text: "Agreed. Refund of $544 approved." }) },
  {
    note: "hotel refund confirmed in Stripe",
    apply: (s) => {
      s.states.hotel = { state: "verified", refunded: 54400, verified: true };
      s.hotel.push({ at: at(45), from: "stripe", kind: "stripe", text: "Refund confirmed in Stripe · $544" });
    },
  },
  {
    note: "Proxy emails the transfer desk",
    apply: (s) => {
      s.states.transfer = { state: "requested", refunded: 0, verified: false };
      s.transfer.push({ at: at(47), from: "proxy", kind: "email", text: "Please cancel booking TRF-ADS71I ($188). It was booked for the wrong date." });
    },
  },
  { note: "desk approves", apply: (s) => void s.transfer.push({ at: at(52), from: "merchant", kind: "reply", text: "Cancelled. Full refund of $188 approved." }) },
  {
    note: "transfer refund confirmed in Stripe",
    apply: (s) => {
      s.states.transfer = { state: "verified", refunded: 18800, verified: true };
      s.transfer.push({ at: at(56), from: "stripe", kind: "stripe", text: "Refund confirmed in Stripe · $188" });
    },
  },
  {
    note: "host gets a correction",
    apply: (s) => {
      s.states.host = { state: "accepted", refunded: 0, verified: false };
    },
  },
  {
    note: "final text to the human",
    apply: (s) =>
      void s.human.push({
        at: at(62),
        direction: "out",
        channel: "imessage",
        text: "All done. $1,144 of $1,240 back, confirmed in Stripe.\n\nHost told the right dates.\nYour agent will rebook for Nov 13.",
      }),
  },
];

export const FIXTURE_LAST_STEP = FIXTURE_STEPS.length - 1;

/** The feed after `step` steps (0 = nothing has happened yet; FIXTURE_STEPS.length = everything). */
export function fixtureFeed(step: number): StageFeed {
  const n = Math.max(0, Math.min(FIXTURE_STEPS.length, Math.floor(step)));
  const d: Draft = { bookings: 0, chain: false, states: {}, human: [], hotel: [], transfer: [], now: T0 };
  for (let i = 0; i < n; i += 1) FIXTURE_STEPS[i].apply(d);

  const booked = BOOKINGS.slice(0, d.bookings);
  const total = booked.reduce((sum, b) => sum + b.amount, 0);
  const rows: StageRow[] = booked.map((b) => {
    const st = d.states[b.id];
    return { id: b.id, label: ROW_LABEL[b.id] ?? b.summary, amount: b.amount, state: st?.state ?? "found", refunded: st?.refunded ?? 0, verified: st?.verified ?? false };
  });
  const recovered = rows.reduce((sum, r) => sum + (r.verified ? r.refunded : 0), 0);
  const done = n >= FIXTURE_STEPS.length;
  const conversations: StageConversation[] = [];
  if (d.hotel.length) conversations.push({ with: "hotel", name: "Harborview Hotel agent", entries: d.hotel });
  if (d.transfer.length) conversations.push({ with: "transfer", name: "Metro Transfer desk", entries: d.transfer });

  return {
    task_id: "task_demo_fixture",
    now: at(n * 2.5),
    task: TASK,
    bookings: booked,
    chain: d.chain ? { chain_id: "chain_fixture", state: done ? "reversed" : d.states.flight ? "undoing" : "alerted", window_ends_at: at(3 * 3600 + 40 * 60 + 8), total, recovered, rows } : null,
    human: d.human,
    conversations,
  };
}
