// Fake data for the stub tools: the demo scenario from docs/05-demo-flow.md.
// Only the flight passes the self-undo rule (self-serve, free, full refund); the hotel needs a
// negotiation, the transfer needs support email and the host email needs a correction.
// Replaced by Store, Logic and the orchestrator once those land.
import type {
  ActionCategory,
  ChainActionView,
  ChainSummary,
  GetChainOutput,
  Lesson,
  Mismatch,
  Reversibility,
} from "../types.js";

export const DEMO_TASK_ID = "task_demo";
export const DEMO_TASK_EMAIL = "task_demo@tasks.proxy.example";
export const DEMO_CHAIN_ID = "chain_demo";

/** Seeded demo time on the simulated clock; the tightest window closes 3h 40m later. */
export const DEMO_NOW = "2026-11-01T14:00:00.000Z";
/**
 * Demo: when the agent's session ends, the simulated clock jumps here, so the late confirmations arrive close to the
 * hotel and transfer deadlines (Nov 2, 00:00). The alert a few seconds later reads "Reversible for 3h 40m".
 */
export const DEMO_LATE_AT = "2026-11-01T20:19:15.000Z";
const DEMO_WINDOW_ENDS = "2026-11-01T17:40:00.000Z";

export const demoActions: ChainActionView[] = [
  {
    action_id: "act_flight",
    merchant: "airline",
    category: "flight",
    summary: "Flight SFO to JFK, Nov 3",
    amount: 41200,
    state: "found",
    route: "self_serve",
    stripe_verified: false,
  },
  {
    action_id: "act_hotel",
    merchant: "hotel",
    category: "hotel",
    summary: "Hotel, 3 nights from Nov 3",
    amount: 64000,
    state: "found",
    route: "reversal_protocol",
    stripe_verified: false,
  },
  {
    action_id: "act_transfer",
    merchant: "transfer",
    category: "transfer",
    summary: "Airport transfer, Nov 3",
    amount: 18800,
    state: "found",
    route: "email_support",
    stripe_verified: false,
  },
  {
    action_id: "act_host_email",
    merchant: "host",
    category: "message",
    summary: "Arrival email to the host, says Nov 3",
    amount: 0,
    state: "found",
    route: "correction",
    stripe_verified: false,
  },
];

export const demoMismatches: Mismatch[] = demoActions.map((a) => ({
  action_id: a.action_id,
  field: "dates",
  expected: "2026-11-13",
  actual: "2026-11-03",
  evidence: { source_action_id: a.action_id, receipt_fields: { summary: a.summary, start_date: "2026-11-03" } },
}));

const moneyAtRisk = demoActions.reduce((sum, a) => sum + a.amount, 0);

export const demoChain: Omit<GetChainOutput, "redo"> = {
  chain_id: DEMO_CHAIN_ID,
  state: "alerted",
  actions: demoActions,
  money_at_risk: moneyAtRisk,
  window_ends_at: DEMO_WINDOW_ENDS,
  rounds: 0,
  next_action: "wait_for_human",
};

export const demoChainSummary: ChainSummary = {
  chain_id: DEMO_CHAIN_ID,
  task_id: DEMO_TASK_ID,
  state: "alerted",
  money_at_risk: moneyAtRisk,
  window_ends_at: DEMO_WINDOW_ENDS,
  action_count: demoActions.length,
  root_summary: "Wrong date: Nov 3 instead of Nov 13",
};

export const demoLessons: Lesson[] = [
  {
    mistake_code: "wrong_date",
    what_happened: "Booked a flight, hotel and transfer for Nov 3 when the intent said Nov 13.",
    lesson: "Read the date from the logged intent, not from search results, before every booking.",
    created_at: DEMO_NOW,
  },
];

/** Demo values from the reversibility table in docs/01-concepts.md. */
export const demoReversibility: Record<ActionCategory, Reversibility> = {
  flight: {
    kind: "cancel_refund",
    window_ends_at: "2026-11-02T14:00:00.000Z",
    refundable: true,
    cost_to_reverse: 0,
    rule: "24-hour rule: full refund within 24 hours if booked at least 7 days out",
  },
  hotel: {
    kind: "cancel_refund",
    window_ends_at: DEMO_WINDOW_ENDS,
    refundable: true,
    cost_to_reverse: 0,
    rule: "Free cancellation until the hotel's deadline, then negotiate with the hotel agent",
  },
  transfer: {
    kind: "cancel_refund",
    window_ends_at: "2026-11-02T20:00:00.000Z",
    refundable: true,
    cost_to_reverse: 0,
    rule: "Free to cancel until shortly before pickup",
  },
  saas: {
    kind: "cancel_refund",
    window_ends_at: "2026-11-15T14:00:00.000Z",
    refundable: true,
    cost_to_reverse: 0,
    rule: "Refund within the vendor's refund window",
  },
  store: {
    kind: "return",
    window_ends_at: "2026-12-01T14:00:00.000Z",
    refundable: true,
    cost_to_reverse: 0,
    rule: "Return within the store's return window",
  },
  message: {
    kind: "correct_message",
    window_ends_at: null,
    refundable: false,
    cost_to_reverse: 0,
    rule: "Send a correction immediately",
  },
};
