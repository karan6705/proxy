// What the stage page (/web/stage) reads, and a fixture that tells the whole demo story step by step.
// GET /demo/feed?task_id=... returns a StageFeed (built in src/orchestrator/stage.ts). GET /web/stage-fixture
// reveals the fixture one step at a time, so the page can be rehearsed and tested without a server run.
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
  /** True for what the agent booked again after the undo. If omitted, the page reads the feed's `redo` entries. */
  rebooked?: boolean;
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
  /** True when the agent refunded this one itself, before Proxy had to. If omitted, the page reads the feed's `self_undo` entries. */
  by_agent?: boolean;
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
  /** "hotel", "transfer" or "host" (or any merchant id). */
  with: string;
  /** Shown on the bubbles, e.g. "Harborview Hotel agent". */
  name: string;
  entries: StageConversationEntry[];
}

/** The orchestrator's plain-English timeline, passed through. The page reads `self_undo` and `redo` from it. */
export interface StageTimelineEntry {
  seq: number;
  at: Timestamp;
  actor: string;
  kind: string;
  text: string;
  data: Record<string, string | number | boolean | null>;
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
  entries?: StageTimelineEntry[];
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

type NewBooking = Omit<StageBooking, "wrong" | "rebooked">;
const wrongBooking = (b: NewBooking): StageBooking => ({ ...b, wrong: true });
const rebooked = (b: NewBooking): StageBooking => ({ ...b, wrong: false, rebooked: true });

interface RowState {
  state: string;
  refunded: Cents;
  verified: boolean;
  by_agent?: boolean;
}

interface Draft {
  bookings: StageBooking[];
  chain: boolean;
  states: Record<string, RowState>;
  human: StageHumanEntry[];
  hotel: StageConversationEntry[];
  transfer: StageConversationEntry[];
  host: StageConversationEntry[];
}

export interface FixtureStep {
  /** Short description, for rehearsal. */
  note: string;
  apply: (s: Draft) => void;
}

const ROW_LABEL: Record<string, string> = {
  flight: "Flight",
  hotel: "Hotel",
  transfer: "Airport transfer",
  host: "Host email",
  seat: "Software seat",
  hub: "USB-C hubs",
  night: "Extra hotel night",
};
const ROW_ORDER = ["flight", "hotel", "transfer", "host", "seat", "hub", "night"];

const alertText = (long: boolean) =>
  long
    ? "Your agent used the wrong date (Nov 3, not Nov 13).\n\n6 things affected · $2,578 at risk of $2,990\nReversible for 3h 40m\n\nReply UNDO ALL, PICK or KEEP."
    : "Your agent used the wrong date (Nov 3, not Nov 13).\n\n3 things affected · $828 at risk of $1,240\nReversible for 3h 40m\n\nReply UNDO ALL, PICK or KEEP.";

const FLIGHT = wrongBooking({ id: "flight", merchant: "airline", category: "flight", summary: "Flight · SFO to JFK", amount: 41200, dates: { start: "2026-11-03" }, at: at(-20) });
const HOTEL = wrongBooking({ id: "hotel", merchant: "hotel", category: "hotel", summary: "Harborview Hotel · 3 nights", amount: 64000, dates: { start: "2026-11-03", end: "2026-11-06" }, at: at(-15) });
const TRANSFER = wrongBooking({ id: "transfer", merchant: "transfer", category: "transfer", summary: "Airport transfer · JFK to hotel", amount: 18800, dates: { start: "2026-11-03" }, at: at(-10) });
const HOST = wrongBooking({ id: "host", merchant: "host", category: "message", summary: "Email to the host", amount: 0, dates: { start: "2026-11-03" }, at: at(-5) });

const LONG_BOOKINGS: StageBooking[] = [
  wrongBooking({ id: "seat", merchant: "saas", category: "saas", summary: "Design tool · annual seat", amount: 120000, at: at(-4) }),
  wrongBooking({ id: "hub", merchant: "store", category: "store", summary: "USB-C hub × 10", amount: 34000, at: at(-3) }),
  wrongBooking({ id: "night", merchant: "hotel", category: "hotel", summary: "Harborview Hotel · extra night", amount: 21000, dates: { start: "2026-11-06", end: "2026-11-07" }, at: at(-2) }),
];

/** The steps of the story. `long` adds more bookings and more back-and-forth, to test columns that overflow. */
export function fixtureSteps(long = false): FixtureStep[] {
  const steps: FixtureStep[] = [
    { note: "flight booked", apply: (s) => void s.bookings.push(FLIGHT) },
    { note: "hotel booked", apply: (s) => void s.bookings.push(HOTEL) },
    { note: "transfer booked", apply: (s) => void s.bookings.push(TRANSFER) },
    { note: "host email sent", apply: (s) => void s.bookings.push(HOST) },
  ];
  if (long) steps.push({ note: "three more bookings arrive", apply: (s) => void s.bookings.push(...LONG_BOOKINGS) });
  steps.push(
    { note: "the agent refunds its own flight", apply: (s) => void (s.states.flight = { state: "verified", refunded: 41200, verified: true, by_agent: true }) },
    {
      note: "chain opens, one text to the human",
      apply: (s) => {
        s.chain = true;
        s.human.push({ at: at(8), direction: "out", channel: "imessage", text: alertText(long) });
      },
    },
    { note: "human replies UNDO ALL", apply: (s) => void s.human.push({ at: at(20), direction: "in", channel: "imessage", text: "UNDO ALL" }) },
    {
      note: "Proxy asks the hotel agent",
      apply: (s) => {
        s.states.hotel = { state: "requested", refunded: 0, verified: false };
        s.hotel.push({ at: at(24), from: "proxy", kind: "request", text: "Our agent booked this hotel for the wrong dates: Nov 3 to 6 instead of Nov 13 to 16. Please reverse booking HTL-F1KEY5 ($640). Evidence attached." });
      },
    },
    { note: "hotel counters with store credit", apply: (s) => void s.hotel.push({ at: at(27), from: "merchant", kind: "counter", text: "We can offer $640 in store credit." }) },
    { note: "Proxy pushes back", apply: (s) => void s.hotel.push({ at: at(31), from: "proxy", kind: "push_back", text: "No store credit, please. This person's preferences exclude it." }) },
    { note: "hotel counters with 85%", apply: (s) => void s.hotel.push({ at: at(35), from: "merchant", kind: "counter", text: "Then a partial refund: 85%, $544." }) },
  );
  if (long) {
    steps.push(
      { note: "Proxy asks for the full amount once more", apply: (s) => void s.hotel.push({ at: at(37), from: "proxy", kind: "push_back", text: "The dates were our agent's mistake, not the guest's. Could you do the full $640?" }) },
      { note: "hotel holds at 85%", apply: (s) => void s.hotel.push({ at: at(39), from: "merchant", kind: "counter", text: "85% is our final offer: $544." }) },
    );
  }
  steps.push(
    { note: "Proxy accepts", apply: (s) => void s.hotel.push({ at: at(41), from: "proxy", kind: "accept_counter", text: "Accepted. 85% is within what this person allows." }) },
    { note: "hotel agrees", apply: (s) => void s.hotel.push({ at: at(44), from: "merchant", kind: "accept", text: "Agreed. Refund of $544 approved." }) },
    {
      note: "hotel refund confirmed in Stripe",
      apply: (s) => {
        s.states.hotel = { state: "verified", refunded: 54400, verified: true };
        s.hotel.push({ at: at(47), from: "stripe", kind: "stripe", text: "Refund confirmed in Stripe · $544" });
      },
    },
    {
      note: "Proxy emails the transfer desk",
      apply: (s) => {
        s.states.transfer = { state: "requested", refunded: 0, verified: false };
        s.transfer.push({ at: at(49), from: "proxy", kind: "email", text: "Please cancel booking TRF-ADS71I ($188). It was booked for the wrong date: Nov 3 instead of Nov 13." });
      },
    },
  );
  if (long) {
    steps.push({ note: "no answer yet, Proxy follows up", apply: (s) => void s.transfer.push({ at: at(55), from: "proxy", kind: "email", text: "Following up on TRF-ADS71I: we have not heard back, and the pickup is for the wrong date." }) });
  }
  steps.push(
    { note: "desk approves", apply: (s) => void s.transfer.push({ at: at(60), from: "merchant", kind: "reply", text: "Cancelled. Full refund of $188 approved." }) },
    {
      note: "transfer refund confirmed in Stripe",
      apply: (s) => {
        s.states.transfer = { state: "verified", refunded: 18800, verified: true };
        s.transfer.push({ at: at(63), from: "stripe", kind: "stripe", text: "Refund confirmed in Stripe · $188" });
      },
    },
    {
      note: "host gets a correction",
      apply: (s) => {
        s.states.host = { state: "accepted", refunded: 0, verified: false };
        s.host.push({ at: at(66), from: "proxy", kind: "correction", text: "Correction: the trip is Nov 13 to 16, not Nov 3. Sorry for the mix-up." });
        s.host.push({ at: at(70), from: "merchant", kind: "reply", text: "No problem, see you on the 13th." });
      },
    },
  );
  if (long) {
    steps.push({
      note: "the other three bookings are cancelled",
      apply: (s) => {
        for (const b of LONG_BOOKINGS) s.states[b.id] = { state: "verified", refunded: b.amount, verified: true };
      },
    });
  }
  steps.push(
    {
      note: "final text to the human",
      apply: (s) =>
        void s.human.push({
          at: at(74),
          direction: "out",
          channel: "imessage",
          text: long
            ? "All done. $2,894 of $2,990 back, confirmed in Stripe.\n\nHost told the right dates.\nYour agent will rebook for Nov 13."
            : "All done. $1,144 of $1,240 back, confirmed in Stripe.\n\nHost told the right dates.\nYour agent will rebook for Nov 13.",
        }),
    },
    {
      note: "the agent rebooks for Nov 13",
      apply: (s) =>
        void s.bookings.push(
          rebooked({ id: "flight2", merchant: "airline", category: "flight", summary: "Flight · SFO to JFK", amount: 41200, dates: { start: "2026-11-13" }, at: at(80) }),
          rebooked({ id: "hotel2", merchant: "hotel", category: "hotel", summary: "Harborview Hotel · 3 nights", amount: 64000, dates: { start: "2026-11-13", end: "2026-11-16" }, at: at(82) }),
          rebooked({ id: "transfer2", merchant: "transfer", category: "transfer", summary: "Airport transfer · JFK to hotel", amount: 18800, dates: { start: "2026-11-13" }, at: at(84) }),
        ),
    },
  );
  return steps;
}

export const FIXTURE_STEPS = fixtureSteps(false);
export const FIXTURE_LAST_STEP = FIXTURE_STEPS.length - 1;

/** The feed after `step` steps (0 = nothing has happened yet; fixtureSteps().length = everything). */
export function fixtureFeed(step: number, long = false): StageFeed {
  const steps = fixtureSteps(long);
  const n = Math.max(0, Math.min(steps.length, Math.floor(step)));
  const d: Draft = { bookings: [], chain: false, states: {}, human: [], hotel: [], transfer: [], host: [] };
  for (let i = 0; i < n; i += 1) steps[i].apply(d);

  // The chain is what the agent booked wrong; the rebooked items are new bookings, not part of it.
  const original = d.bookings.filter((b) => !b.rebooked);
  const rows: StageRow[] = original
    .map((b) => {
      const st = d.states[b.id];
      return { id: b.id, label: ROW_LABEL[b.id] ?? b.summary, amount: b.amount, state: st?.state ?? "found", refunded: st?.refunded ?? 0, verified: st?.verified ?? false, ...(st?.by_agent ? { by_agent: true } : {}) };
    })
    .sort((a, b) => ROW_ORDER.indexOf(a.id) - ROW_ORDER.indexOf(b.id));
  const total = original.reduce((sum, b) => sum + b.amount, 0);
  const recovered = rows.reduce((sum, r) => sum + (r.verified ? r.refunded : 0), 0);
  const finished = d.human.some((h) => h.direction === "out" && /^All done/.test(h.text));

  const conversations: StageConversation[] = [];
  if (d.hotel.length) conversations.push({ with: "hotel", name: "Harborview Hotel agent", entries: d.hotel });
  if (d.transfer.length) conversations.push({ with: "transfer", name: "Metro Transfer support", entries: d.transfer });
  if (d.host.length) conversations.push({ with: "host", name: "Host", entries: d.host });

  return {
    task_id: "task_demo_fixture",
    now: at(n * 2.5),
    task: TASK,
    bookings: d.bookings,
    chain: d.chain ? { chain_id: "chain_fixture", state: finished ? "reversed" : d.states.hotel ? "undoing" : "alerted", window_ends_at: at(3 * 3600 + 40 * 60 + 8), total, recovered, rows } : null,
    human: d.human,
    conversations,
  };
}
