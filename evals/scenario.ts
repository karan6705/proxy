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
  /** Mistakes Proxy must catch. */
  mismatches: ExpectedMismatch[];
  /**
   * Real mistakes (against the human's actual request) that Proxy is documented NOT to catch. The scenario passes only
   * while Proxy still misses them, so if Proxy improves, the test fails and the scenario must be updated. They count
   * as misses in the scoreboard.
   */
  known_misses?: ExpectedMismatch[];
  /**
   * Things that are NOT mistakes but that Proxy is documented to flag anyway. The scenario passes only while Proxy
   * still flags them. They count as false alarms in the scoreboard.
   */
  known_false_alarms?: ExpectedMismatch[];
  /** The merchant sent text that is not part of the protocol, and Proxy saw it and did not act on it. */
  ignored_text?: boolean;
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
  /** What the human really asked for. This is the ground truth the expected results are written against. */
  intent: Intent;
  /**
   * What the agent logged with log_intent, which is the only thing Proxy can compare receipts against. Defaults to
   * the intent. When the agent logs the wrong thing, compare calls the wrong bookings clean, so the mistake is a
   * documented known miss.
   */
  logged_intent?: Pick<Intent, "goal" | "constraints">;
  /**
   * What the agent believes the task was, for the naive arm (the agent checking its own work). Defaults to the
   * intent. When the agent misread the task, this differs, and a self-review against it finds nothing wrong.
   */
  agent_belief?: Pick<Intent, "goal" | "constraints">;
  /** Booking ids the agent never saw succeed (for example a call that timed out but went through). */
  unseen_by_agent?: string[];
  /**
   * Amounts the agent believes it paid, by booking id, when they differ from what was charged (a price that rose after
   * the quote). The naive arm's self-review sees these, not the charge.
   */
  agent_saw_amounts?: Record<string, Cents>;
  /**
   * Why agent_belief and unseen_by_agent are what they are. These are scripted assumptions about the agent, not
   * measurements: what a real agent notices comes from the live-agent layer.
   */
  assumption: string;
  bookings: SimBooking[];
  /** When Proxy looks at the chain. Windows and the plan are computed at this time. */
  now: Timestamp;
  /**
   * The human's text reply to the alert. { pick: [...] } is PICK: only those booking ids are undone. null: no reply,
   * and if the intent's preferences set auto_undo, Proxy undoes everything before the window closes.
   */
  human_reply: "UNDO ALL" | "KEEP" | { pick: string[] } | null;
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
  /** Untrusted merchant text Proxy saw and did not act on: where it came from, never the text itself. */
  ignored_text: { action: string; field: string }[];
  /** A readable log of what happened, in order. */
  transcript: string[];
}

export interface Grade {
  scenario_id: string;
  arm: Arm;
  mistakes: {
    /** Real mistakes: the ones Proxy must catch plus the documented known misses. */
    expected: number;
    caught: number;
    /** Every real mistake that was not found. */
    missed: string[];
    /** How many of the misses are documented known misses. */
    known_misses: number;
    /** Misses that were not documented: these fail the scenario. */
    unexpected_misses: string[];
    /** A documented known miss that Proxy now catches: update the scenario. */
    surprise_catches: string[];
    /** Flagged but not a mistake, and not documented: these fail the scenario. */
    false_alarms: string[];
    /** How many documented false alarms occurred, as expected. */
    known_false_alarms: number;
    /** A documented false alarm that no longer happens: update the scenario. */
    missing_known_false_alarms: string[];
  };
  chains: { expected: number; found: number; expected_members: number; found_members: number; all_correct: boolean };
  alert_correct: boolean;
  /** null when the scenario does not check it. */
  ignored_text_ok: boolean | null;
  outcomes: { expected: number; correct: number; wrong: string[] };
  agreed_refund: { expected: Cents | null; actual: Cents; correct: boolean | null };
  /** The agent said it was done while real mistakes were sitting in its receipts. */
  false_done_claim: boolean;
  /** Everything checked matched. */
  passed: boolean;
}
