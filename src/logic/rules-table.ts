// The reversibility rules as DATA, one entry per merchant type: the window, the cheapest route, and the cost to undo.
// Values come from rules.ts (the same constants the mock merchants use), so nothing here can drift from the simulators.
// reversibility() in reversibility.ts is the executable version. Tests check that the two agree.
//
// Two entries have no ActionCategory yet (domain, final_sale). They are keyed by merchant type for that reason;
// ruleKeyForCategory() covers the six categories types.ts defines.

import type { ActionCategory, Cents, RouteKind } from "../types.js";
import {
  DOMAIN_ADD_GRACE_DAYS,
  FLIGHT_CHANGE_CUTOFF_HOURS,
  FLIGHT_CHANGE_FEE,
  FLIGHT_FREE_CANCEL_HOURS,
  FLIGHT_MIN_DAYS_OUT,
  HOTEL_NEGOTIATION_CUTOFF_HOURS,
  SAAS_REFUND_DAYS,
  STORE_LATE_RETURN_DAYS,
  STORE_RESTOCKING_FEE,
  STORE_RETURN_DAYS,
  TRANSFER_FREE_CANCEL_HOURS,
} from "./rules.js";

export type RuleKey = "airline" | "hotel" | "transfer" | "saas" | "store" | "domain" | "final_sale" | "message";

export type WindowAnchor = "booking" | "departure" | "check_in" | "pickup" | "registration";

export interface RuleWindow {
  anchor: WindowAnchor;
  /** Length of the window in hours. */
  hours: number;
  /** "after": the window ends `hours` after the anchor. "before": it ends `hours` before it. */
  direction: "after" | "before";
}

export type CostRule =
  | { type: "none" }
  /** A flat fee, never more than the price. */
  | { type: "flat"; cents: Cents }
  | { type: "percent"; fraction: number }
  /** The whole price is lost. */
  | { type: "full" };

export interface RuleEntry {
  key: RuleKey;
  label: string;
  /** The cheapest route while the primary window is open. */
  route: RouteKind;
  /** null when there is no window (final sale, sent messages). */
  window: RuleWindow | null;
  reversible: boolean;
  refundable: boolean;
  cost_to_undo: CostRule;
  /** What is still possible once the primary window has closed. null = nothing, go to the damage minimizer. */
  after_window: { route: RouteKind; window: RuleWindow | null; cost_to_undo: CostRule; note: string } | null;
  conditions: string[];
  /** Human-readable rule. */
  rule: string;
  /** Where the rule comes from, and whether to check it before quoting it as fact. */
  basis: string;
}

const HOURS_PER_DAY = 24;

export const RULES_TABLE: Readonly<Record<RuleKey, RuleEntry>> = {
  airline: {
    key: "airline",
    label: "Airline ticket",
    route: "self_serve",
    window: { anchor: "booking", hours: FLIGHT_FREE_CANCEL_HOURS, direction: "after" },
    reversible: true,
    refundable: true,
    cost_to_undo: { type: "none" },
    after_window: {
      route: "email_support",
      window: { anchor: "departure", hours: FLIGHT_CHANGE_CUTOFF_HOURS, direction: "before" },
      cost_to_undo: { type: "flat", cents: FLIGHT_CHANGE_FEE },
      note: "Past the 24-hour window the fare is non-refundable, but it can be changed for a fee.",
    },
    conditions: [`Departure at least ${FLIGHT_MIN_DAYS_OUT} days after booking`],
    rule: "24-hour rule: full refund if cancelled within 24 hours of booking, for flights booked at least 7 days out",
    basis: "Our mock airline, modeled on the US DOT 24-hour rule. Confirm on dot.gov before quoting it as law.",
  },
  hotel: {
    key: "hotel",
    label: "Hotel stay",
    route: "reversal_protocol",
    window: { anchor: "check_in", hours: HOTEL_NEGOTIATION_CUTOFF_HOURS, direction: "before" },
    reversible: true,
    refundable: false,
    cost_to_undo: { type: "none" },
    after_window: null,
    conditions: ["Non-refundable advance-purchase rate", "Any refund or credit is at the hotel agent's discretion"],
    rule: "Non-refundable rate: the hotel agent may grant a goodwill refund or credit until 24 hours before check-in",
    basis: "Our mock hotel. Real hotel policies vary.",
  },
  transfer: {
    key: "transfer",
    label: "Airport transfer",
    route: "email_support",
    window: { anchor: "pickup", hours: TRANSFER_FREE_CANCEL_HOURS, direction: "before" },
    reversible: true,
    refundable: true,
    cost_to_undo: { type: "none" },
    after_window: null,
    conditions: ["Cancel by emailing support with the booking reference"],
    rule: "Free cancellation until 24 hours before pickup, by email to support",
    basis: "Our mock transfer company.",
  },
  saas: {
    key: "saas",
    label: "SaaS subscription",
    route: "email_support",
    window: { anchor: "booking", hours: SAAS_REFUND_DAYS * HOURS_PER_DAY, direction: "after" },
    reversible: true,
    refundable: true,
    cost_to_undo: { type: "none" },
    after_window: null,
    conditions: ["Cancelling after the window stops future charges but does not refund"],
    rule: "Full refund within 14 days of signup",
    basis: "Our mock SaaS vendor.",
  },
  store: {
    key: "store",
    label: "Physical item from a store",
    route: "email_support",
    window: { anchor: "booking", hours: STORE_RETURN_DAYS * HOURS_PER_DAY, direction: "after" },
    reversible: true,
    refundable: true,
    cost_to_undo: { type: "none" },
    after_window: {
      route: "email_support",
      window: { anchor: "booking", hours: STORE_LATE_RETURN_DAYS * HOURS_PER_DAY, direction: "after" },
      cost_to_undo: { type: "percent", fraction: STORE_RESTOCKING_FEE },
      note: "Late returns carry a restocking fee.",
    },
    conditions: ["Item must be unused and returned with the label"],
    rule: "Free returns within 30 days; a 15% restocking fee until day 60",
    basis: "Our mock store.",
  },
  domain: {
    key: "domain",
    label: "Domain registration",
    route: "self_serve",
    window: { anchor: "registration", hours: DOMAIN_ADD_GRACE_DAYS * HOURS_PER_DAY, direction: "after" },
    reversible: true,
    refundable: true,
    cost_to_undo: { type: "none" },
    after_window: null,
    conditions: ["Deleting the domain through the registrar inside the Add Grace Period"],
    rule: "Add Grace Period: delete a new registration within about 5 days for a refund",
    basis: "Usually 5 days for generic TLDs. Verify the exact rule for the TLD before quoting it as fact.",
  },
  final_sale: {
    key: "final_sale",
    label: "Final-sale item",
    route: "stripe_dispute",
    window: null,
    reversible: false,
    refundable: false,
    cost_to_undo: { type: "full" },
    after_window: null,
    conditions: ["Not reversible: go straight to the damage minimizer", "A Stripe dispute is only possible if the item was misrepresented"],
    rule: "Final sale: not reversible",
    basis: "Our mock rule.",
  },
  message: {
    key: "message",
    label: "Message the agent sent",
    route: "correction",
    window: null,
    reversible: true,
    refundable: false,
    cost_to_undo: { type: "none" },
    after_window: null,
    conditions: ["A correction is a follow-up message, not a recall"],
    rule: "A sent message can always be corrected with a follow-up",
    basis: "By nature of email.",
  },
};

const CATEGORY_TO_RULE: Readonly<Record<ActionCategory, RuleKey>> = {
  flight: "airline",
  hotel: "hotel",
  transfer: "transfer",
  saas: "saas",
  store: "store",
  message: "message",
};

export function ruleKeyForCategory(category: ActionCategory): RuleKey {
  return CATEGORY_TO_RULE[category];
}

export function getRule(key: RuleKey): RuleEntry {
  return RULES_TABLE[key];
}

/**
 * The rule that applies to one action. The table is keyed by merchant: an action whose merchant id is a table key
 * (for example "final_sale") uses that entry, and every other action uses the entry for its category.
 */
export function ruleKeyForAction(action: { merchant: string; category: ActionCategory }): RuleKey {
  return action.merchant in RULES_TABLE ? (action.merchant as RuleKey) : ruleKeyForCategory(action.category);
}

/** What undoing costs the human, for a given price. A flat fee never exceeds the price. */
export function costOf(cost: CostRule, amount: Cents): Cents {
  switch (cost.type) {
    case "none":
      return 0;
    case "flat":
      return Math.min(cost.cents, amount);
    case "percent":
      return Math.round(amount * cost.fraction);
    case "full":
      return amount;
  }
}
