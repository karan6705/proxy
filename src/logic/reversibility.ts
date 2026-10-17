// reversibility(action, now): how an action can still be undone, and what it costs.
// windowEndsAt(action): the end of the cheapest window. It does not depend on `now`, so trace() can use it.

import type { Action, Reversibility, Timestamp } from "../types.js";
import { MS_PER_DAY, MS_PER_HOUR, dateToMs, msToTimestamp, timestampToMs } from "./dates.js";
import {
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

/** The 24-hour flight rule only applies to flights booked at least 7 days before departure. */
function flightQualifiesFor24HourRule(action: Action): boolean {
  if (!action.dates) {
    return true;
  }
  const daysOut = (dateToMs(action.dates.start) - timestampToMs(action.received_at)) / MS_PER_DAY;
  return daysOut >= FLIGHT_MIN_DAYS_OUT;
}

function hoursBeforeStart(action: Action, hours: number): number | null {
  return action.dates ? dateToMs(action.dates.start) - hours * MS_PER_HOUR : null;
}

function windowEndMs(action: Action): number | null {
  const received = timestampToMs(action.received_at);
  switch (action.category) {
    case "flight":
      return flightQualifiesFor24HourRule(action)
        ? received + FLIGHT_FREE_CANCEL_HOURS * MS_PER_HOUR
        : hoursBeforeStart(action, FLIGHT_CHANGE_CUTOFF_HOURS);
    case "hotel":
      return hoursBeforeStart(action, HOTEL_NEGOTIATION_CUTOFF_HOURS);
    case "transfer":
      return hoursBeforeStart(action, TRANSFER_FREE_CANCEL_HOURS);
    case "saas":
      return received + SAAS_REFUND_DAYS * MS_PER_DAY;
    case "store":
      return received + STORE_RETURN_DAYS * MS_PER_DAY;
    case "message":
      return null;
  }
}

export function windowEndsAt(action: Action): Timestamp | null {
  const end = windowEndMs(action);
  return end === null ? null : msToTimestamp(end);
}

function none(rule: string): Reversibility {
  return { kind: "none", window_ends_at: null, refundable: false, cost_to_reverse: 0, rule };
}

export function reversibility(action: Action, now: Timestamp): Reversibility {
  const nowMs = timestampToMs(now);
  const primaryEnd = windowEndMs(action);
  const inPrimaryWindow = primaryEnd !== null && nowMs <= primaryEnd;

  switch (action.category) {
    case "flight": {
      if (inPrimaryWindow && flightQualifiesFor24HourRule(action)) {
        return {
          kind: "cancel_refund",
          window_ends_at: msToTimestamp(primaryEnd),
          refundable: true,
          cost_to_reverse: 0,
          rule: "24-hour rule: full refund if cancelled within 24 hours of booking, for flights booked at least 7 days out",
        };
      }
      const changeCutoff = hoursBeforeStart(action, FLIGHT_CHANGE_CUTOFF_HOURS);
      if (changeCutoff !== null && nowMs <= changeCutoff) {
        return {
          kind: "change",
          window_ends_at: msToTimestamp(changeCutoff),
          refundable: false,
          cost_to_reverse: Math.min(FLIGHT_CHANGE_FEE, action.amount),
          rule: flightQualifiesFor24HourRule(action)
            ? "Past the 24-hour window: the flight can be changed for a $75 fee until 24 hours before departure"
            : "Booked less than 7 days before departure, so no 24-hour refund: the flight can be changed for a $75 fee until 24 hours before departure",
        };
      }
      return none("The flight can no longer be changed or refunded");
    }
    case "hotel": {
      if (inPrimaryWindow) {
        return {
          kind: "cancel_refund",
          window_ends_at: msToTimestamp(primaryEnd),
          refundable: false,
          cost_to_reverse: 0,
          rule: "Non-refundable advance-purchase rate: the hotel may grant a goodwill refund or credit until 24 hours before check-in, but nothing is guaranteed",
        };
      }
      return none("Too close to check-in for a goodwill refund, or no dates on the booking");
    }
    case "transfer": {
      if (inPrimaryWindow) {
        return {
          kind: "cancel_refund",
          window_ends_at: msToTimestamp(primaryEnd),
          refundable: true,
          cost_to_reverse: 0,
          rule: "Free cancellation until 24 hours before pickup",
        };
      }
      return none("Past the free-cancellation deadline: no refund");
    }
    case "saas": {
      if (inPrimaryWindow) {
        return {
          kind: "cancel_refund",
          window_ends_at: msToTimestamp(primaryEnd),
          refundable: true,
          cost_to_reverse: 0,
          rule: "Full refund within 14 days of signup",
        };
      }
      return none("Refund window closed: cancelling stops future charges but does not refund");
    }
    case "store": {
      if (inPrimaryWindow) {
        return {
          kind: "return",
          window_ends_at: msToTimestamp(primaryEnd),
          refundable: true,
          cost_to_reverse: 0,
          rule: "Free returns within 30 days",
        };
      }
      const lateEnd = timestampToMs(action.received_at) + STORE_LATE_RETURN_DAYS * MS_PER_DAY;
      if (nowMs <= lateEnd) {
        return {
          kind: "return",
          window_ends_at: msToTimestamp(lateEnd),
          refundable: true,
          cost_to_reverse: Math.round(action.amount * STORE_RESTOCKING_FEE),
          rule: "Late return: 15% restocking fee until day 60",
        };
      }
      return none("Return window closed");
    }
    case "message":
      return {
        kind: "correct_message",
        window_ends_at: null,
        refundable: false,
        cost_to_reverse: 0,
        rule: "A sent message can always be corrected with a follow-up",
      };
  }
}
