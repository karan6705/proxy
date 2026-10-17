// The demo case: "NYC trip for the Nov 13 conference, under $1,500", booked with the wrong date (Nov 3).
// Flight $412 + hotel $640 + transfer $188 + arrival email to the host = $1,240 across 4 things.

import type {
  Action,
  Chain,
  Clock,
  EvidencePacket,
  Intent,
  Mismatch,
  Preferences,
  RequestReversal,
  SimulatedClock,
  Timestamp,
} from "../../src/types.js";

/** The flight is booked at 09:00 and its confirmation is captured at 09:05. The 24-hour window ends 09:05 next day. */
export const FLIGHT_BOOKED_AT = "2026-10-17T09:00:00.000Z";
export const FLIGHT_WINDOW_END = "2026-10-18T09:05:00.000Z";
/** 3h 40m before the flight's 24-hour window ends: "Fully reversible for 3h 40m". */
export const DEMO_NOW = "2026-10-18T05:25:00.000Z";

export const PREFERENCES: Preferences = {
  no_store_credit: true,
  min_partial_refund_pct: 80,
  auto_undo: false,
};

export function demoIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    task_id: "task_nyc",
    task_email: "task-nyc@inbox.proxy.example",
    goal: "NYC trip for the Nov 13 conference, under $1,500",
    constraints: {
      dates: { start: "2026-11-13", end: "2026-11-16" },
      budget_total: 150000,
    },
    preferences: PREFERENCES,
    created_at: "2026-10-17T09:00:00.000Z",
    ...overrides,
  };
}

function action(fields: Partial<Action> & Pick<Action, "action_id" | "merchant" | "category" | "summary" | "amount" | "ref" | "received_at">): Action {
  return { task_id: "task_nyc", source: "email", state: "found", ...fields };
}

/** wrong = true: everything is booked for Nov 3. wrong = false: the same trip for Nov 13 to 16. */
export function demoActions(wrong = true): Action[] {
  const arrival = wrong ? "2026-11-03" : "2026-11-13";
  const checkout = wrong ? "2026-11-06" : "2026-11-16";
  return [
    action({
      action_id: "act_flight",
      merchant: "airline",
      category: "flight",
      summary: "Flight SFO to JFK",
      amount: 41200,
      dates: { start: arrival },
      ref: "AIR-DEMO01",
      received_at: "2026-10-17T09:05:00.000Z",
    }),
    action({
      action_id: "act_transfer",
      merchant: "transfer",
      category: "transfer",
      summary: "Airport transfer, JFK to hotel",
      amount: 18800,
      dates: { start: arrival },
      ref: "TRF-DEMO01",
      received_at: "2026-10-17T09:20:00.000Z",
    }),
    action({
      action_id: "act_host_email",
      merchant: "host",
      category: "message",
      summary: `Arrival email to the host: arriving ${arrival}`,
      amount: 0,
      dates: { start: arrival },
      ref: "MSG-DEMO01",
      source: "agent",
      received_at: "2026-10-17T09:30:00.000Z",
    }),
    // The hotel confirmation arrives late, after the agent's session has ended.
    action({
      action_id: "act_hotel",
      merchant: "hotel",
      category: "hotel",
      summary: "Harborview Hotel, 3 nights",
      amount: 64000,
      dates: { start: arrival, end: checkout },
      ref: "HTL-DEMO01",
      received_at: "2026-10-17T11:05:00.000Z",
    }),
  ];
}

export function demoMismatches(): Mismatch[] {
  return ["act_flight", "act_transfer", "act_host_email"].map((action_id) => ({
    action_id,
    field: "dates" as const,
    expected: "2026-11-13",
    actual: "2026-11-03",
  })).concat([{ action_id: "act_hotel", field: "dates", expected: "2026-11-13", actual: "2026-11-03" }]);
}

export function makeChain(overrides: Partial<Chain> & Pick<Chain, "chain_id">): Chain {
  return {
    task_id: "task_nyc",
    root_action_id: "act_flight",
    action_ids: ["act_flight"],
    money_at_risk: 0,
    window_ends_at: null,
    state: "alerted",
    alerts: [],
    plan: [],
    steps: [],
    ...overrides,
  };
}

export function fakeClock(start: Timestamp = DEMO_NOW): SimulatedClock {
  let ms = Date.parse(start);
  return {
    mode: "simulated",
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    set: (t: Timestamp) => {
      ms = Date.parse(t);
    },
    advance: (delta: number) => {
      ms += delta;
    },
  } satisfies Clock & SimulatedClock;
}

/** A valid request_reversal for a booking, as Proxy would send it. */
export function requestReversal(
  ref: string,
  merchant: string,
  amount: number,
  overrides: Partial<RequestReversal> = {},
): RequestReversal {
  const intent = demoIntent();
  const order = demoActions().find((a) => a.ref === ref || a.merchant === merchant) ?? demoActions()[0];
  const mismatch: Mismatch = { action_id: order.action_id, field: "dates", expected: "2026-11-13", actual: "2026-11-03" };
  const evidence: EvidencePacket = {
    intent,
    order,
    confirmation_excerpt: `Booking ${ref}`,
    stripe_charge_id: "ch_test_1",
    mismatch,
    why_wrong: "Booked for Nov 3, but the task is for the Nov 13 conference.",
    deadline: "2026-11-02T00:00:00.000Z",
  };
  return {
    type: "request_reversal",
    negotiation_id: "neg_1",
    chain_id: "chain_act_flight",
    action_id: order.action_id,
    round: 1,
    sent_at: DEMO_NOW,
    order: { merchant, ref, amount },
    intent: { goal: intent.goal, constraints: intent.constraints },
    what_went_wrong: evidence.why_wrong,
    deadline: evidence.deadline,
    evidence,
    ...overrides,
  };
}

/** Pulls the schema.org JSON-LD block out of a confirmation email's HTML. */
export function extractJsonLd(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("No JSON-LD block found in the email HTML");
  }
  return JSON.parse(match[1]);
}
