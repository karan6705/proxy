// The reversibility rules table. These are OUR mock merchants' rules, not industry facts.
// The merchants in src/merchants/ use the same constants, so the rules and the simulators cannot drift.
//
// | Category | Primary window (cheapest fix)                         | After the primary window                                    |
// |----------|-------------------------------------------------------|-------------------------------------------------------------|
// | flight   | 24 hours after booking, full refund, but only if      | "change": $75 fee, until 24h before departure               |
// |          | departure is at least 7 days after booking            | (also the only option when booked less than 7 days out)     |
// | hotel    | Non-refundable rate. The hotel agent may grant a      | none                                                        |
// |          | goodwill refund or credit until 24h before check-in   |                                                             |
// | transfer | Free cancel until 24h before pickup                   | none                                                        |
// | saas     | Full refund within 14 days of signup                  | none                                                        |
// | store    | Free return within 30 days                            | "return" with a 15% restocking fee until day 60, then none  |
// | message  | No window: a sent message can always be corrected     | same                                                        |
//
// The 24-hour flight rule is based on the US DOT rule (an airline must either hold a fare for 24 hours or allow a
// full-refund cancel within 24 hours, for flights booked at least 7 days out). Confirm on the DOT site before
// quoting it as law.

import type { Cents } from "../types.js";

export const FLIGHT_FREE_CANCEL_HOURS = 24;
export const FLIGHT_MIN_DAYS_OUT = 7;
/** Flight change fee after the 24-hour window, in cents ($75). */
export const FLIGHT_CHANGE_FEE: Cents = 7500;
/** Last moment a flight change is allowed, in hours before departure. */
export const FLIGHT_CHANGE_CUTOFF_HOURS = 24;

/** Hotel goodwill refunds are negotiable until this many hours before check-in. */
export const HOTEL_NEGOTIATION_CUTOFF_HOURS = 24;

/** Transfers cancel free until this many hours before pickup. */
export const TRANSFER_FREE_CANCEL_HOURS = 24;

export const SAAS_REFUND_DAYS = 14;

/** Domain "Add Grace Period": delete a new registration for a refund. Usually 5 days; verify the TLD's rule before quoting it. */
export const DOMAIN_ADD_GRACE_DAYS = 5;

export const STORE_RETURN_DAYS = 30;
export const STORE_LATE_RETURN_DAYS = 60;
/** Restocking fee for late returns, as a fraction of the price. */
export const STORE_RESTOCKING_FEE = 0.15;

/** Proposed default for rank(). Params has no default for MIN_HOURS, so this is agreed at the freeze. */
export const DEFAULT_MIN_HOURS = 0.25;
