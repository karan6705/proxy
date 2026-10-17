// The shape of a scenario, and of what the runner and grader produce.
//
// A scenario is scripted: the bookings the agent made (with seeded times), what the human replies to the alert, and
// the expected results, written by hand and independent of compare/trace/plan_undo, so the grader does not share the
// logic's blind spots. Sarah reviews the expected results.
//
// Booking ids ("flight", "hotel", ...) stand for actions: booking "flight" is action "act_flight".

import type { Arm, Cents, Intent, MismatchField, Timestamp } from "../src/types.js";
import type { HotelAgentOptions } from "../src/merchants/index.js";
import type { SimBooking } from "./sim.js";

export type { Arm } from "../src/types.js";

/** What happened to one action after the human's reply. */
export type Outcome =
  /** The merchant agreed a refund, to be issued and verified by the orchestrator through Payments. */
  | "refund_agreed"
  /** A sent message was corrected. */
  | "corrected"
  /** The loss was accepted: the human said KEEP, or nothing could still be fixed. */
  | "kept"
  /** Proxy tried and the merchant did not agree. */
  | "not_undone"
  /** The negotiation went to the human to decide. */
  | "asked_human"
  /** Nothing happened to this action. */
  | "none";

export interface ExpectedMismatch {
  /** Booking id, e.g. "flight". */
  action: string;
  field: MismatchField;
}

export interface ExpectedChain {
  /** Booking ids in the chain. Order does not matter. */
  actions: string[];
  root: string;
  money_at_risk: Cents;
}

export interface ScenarioExpect {
  mismatches: ExpectedMismatch[];
  chains: ExpectedChain[];
  /** Whether the human gets the one text. */
  alert: boolean;
  /** After the human's reply: what each action ends as. Actions not listed are not checked. */
  outcomes?: Record<string, Outcome>;
  /** Total refund the merchants agree to, in cents. */
  agreed_refund_total?: Cents;
}

export interface Scenario {
  id: string;
  title: string;
  group: string;
  /** What the human really asked for. */
  intent: Intent;
  /**
   * What the agent believes the task was, for the naive arm (the agent checking its own work). Defaults to the
   * intent. When the agent misread the task, this differs, and a self-review against it finds nothing wrong.
   */
  agent_belief?: Pick<Intent, "goal" | "constraints">;
  /** Booking ids the agent never saw succeed (for example a call that timed out but went through). */
  unseen_by_agent?: string[];
  /**
   * Why agent_belief and unseen_by_agent are what they are. These are scripted assumptions about the agent, not
   * measurements: what a real agent notices comes from the live-agent layer.
   */
  assumption: string;
  bookings: SimBooking[];
  /** When Proxy looks at the chain. Windows and the plan are computed at this time. */
  now: Timestamp;
  /** The human's text reply to the alert. null: no reply. */
  human_reply: "UNDO ALL" | "KEEP" | null;
  hotel?: HotelAgentOptions;
  expect: ScenarioExpect;
}

export interface FoundMismatch {
  action: string;
  field: MismatchField;
}

export interface FoundChain {
  actions: string[];
  root: string;
  money_at_risk: Cents;
}

export interface RunResult {
  scenario_id: string;
  arm: Arm;
  mismatches: FoundMismatch[];
  chains: FoundChain[];
  alert_sent: boolean;
  outcomes: Record<string, Outcome>;
  agreed_refund_total: Cents;
  /** Naive arm only: the agent reports the task done. */
  claims_done: boolean;
  /** Reversal Protocol rounds used, per booking id. */
  negotiation_rounds: Record<string, number>;
  /** A readable log of what happened, in order. */
  transcript: string[];
}

export interface Grade {
  scenario_id: string;
  arm: Arm;
  mistakes: { expected: number; caught: number; missed: string[]; false_alarms: string[] };
  chains: { expected: number; found: number; expected_members: number; found_members: number; all_correct: boolean };
  alert_correct: boolean;
  outcomes: { expected: number; correct: number; wrong: string[] };
  agreed_refund: { expected: Cents | null; actual: Cents; correct: boolean | null };
  /** The agent said it was done while real mistakes were sitting in its receipts. */
  false_done_claim: boolean;
  /** Everything checked matched. */
  passed: boolean;
}
