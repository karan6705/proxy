// Mock airline: no agent. Cancels itself under the US-style 24-hour rule (full refund within 24 hours of booking,
// for flights booked at least 7 days before departure). After that the only option is a $75 change fee.

import { MS_PER_DAY, MS_PER_HOUR, dateToMs, timestampToMs } from "../logic/dates.js";
import { FLIGHT_CHANGE_FEE, FLIGHT_FREE_CANCEL_HOURS, FLIGHT_MIN_DAYS_OUT } from "../logic/rules.js";
import type { MerchantInfo, SelfServeCancelResult } from "../types.js";
import type { MerchantModule } from "./deps.js";
import { formatDate, formatMoney, renderEmail } from "./emails.js";
import { type AirportInfo, flightReservation } from "./jsonld.js";
import {
  type BookingSpec,
  type MerchantOrder,
  type ModuleContext,
  placeOrder,
  refundOrder,
  sendConfirmation as sendOrderConfirmation,
} from "./orders.js";

export const AIRLINE_INFO: MerchantInfo = {
  merchant_id: "airline",
  name: "Skyline Demo Air",
  category: "flight",
  has_agent: false,
  support_email: "reservations@skylinedemoair.example",
};

const FROM = { name: AIRLINE_INFO.name, address: "reservations@skylinedemoair.example" };
const IATA_CODE = "ZZ";

const AIRPORTS: Record<string, AirportInfo> = {
  SFO: { code: "SFO", name: "San Francisco International Airport", zone: "PT" },
  LAX: { code: "LAX", name: "Los Angeles International Airport", zone: "PT" },
  SEA: { code: "SEA", name: "Seattle-Tacoma International Airport", zone: "PT" },
  JFK: { code: "JFK", name: "John F. Kennedy International Airport", zone: "ET" },
  BOS: { code: "BOS", name: "Boston Logan International Airport", zone: "ET" },
};

function airport(code: string): AirportInfo {
  return AIRPORTS[code] ?? { code, name: `${code} Airport`, zone: "ET" };
}

/** "SFO-JFK", "SFO to JFK" or "Flight SFO to JFK". Defaults to SFO to JFK. */
function parseRoute(item: string): { from: AirportInfo; to: AirportInfo } {
  const match = item.match(/\b([A-Za-z]{3})\s*(?:-|to|→)\s*([A-Za-z]{3})\b/);
  return match
    ? { from: airport(match[1].toUpperCase()), to: airport(match[2].toUpperCase()) }
    : { from: airport("SFO"), to: airport("JFK") };
}

function flightNumberFor(ref: string): string {
  const sum = [...ref].reduce((total, char) => total + char.charCodeAt(0), 0);
  return String(100 + (sum % 900));
}

function render(order: MerchantOrder) {
  const route = parseRoute(order.item);
  const flightNumber = flightNumberFor(order.ref);
  const day = order.dates.start;
  return renderEmail({
    from: FROM,
    to: order.task_email,
    subject: `Your flight is confirmed: ${route.from.code} to ${route.to.code} on ${formatDate(day)} (${order.ref})`,
    heading: "Your flight is confirmed",
    intro: `Thanks for booking with ${AIRLINE_INFO.name}. Your reservation is confirmed and your ticket has been issued.`,
    details: [
      ["Confirmation number", order.ref],
      ["Flight", `${IATA_CODE} ${flightNumber}`],
      ["From", `${route.from.name} (${route.from.code})`],
      ["To", `${route.to.name} (${route.to.code})`],
      ["Departs", `${formatDate(day)}, 8:30 AM`],
      ["Arrives", `${formatDate(day)}, 5:05 PM`],
      ["Fare", "Basic Economy"],
      ["Total paid", formatMoney(order.amount)],
    ],
    footer: `You can cancel within ${FLIGHT_FREE_CANCEL_HOURS} hours of booking for a full refund if your flight is at least ${FLIGHT_MIN_DAYS_OUT} days away. After that, changes cost ${formatMoney(FLIGHT_CHANGE_FEE)} until 24 hours before departure.`,
    jsonld: flightReservation(order, {
      airline: { name: AIRLINE_INFO.name, iataCode: IATA_CODE },
      flightNumber,
      from: route.from,
      to: route.to,
      departLocal: "08:30",
      arriveLocal: "17:05",
    }),
  });
}

export function createAirline(ctx: ModuleContext): MerchantModule {
  const spec: BookingSpec = { info: AIRLINE_INFO, ref_prefix: "AIR", dates: "single", render };

  const refuse = (reason: string): SelfServeCancelResult => ({
    ok: false,
    refund_amount: 0,
    stripe_refund_id: null,
    reason,
  });

  return {
    info: AIRLINE_INFO,
    agent: null,
    handleSupportEmail: null,

    book: (request) => placeOrder(ctx, spec, request),

    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(ref, now) {
      const order = ctx.orders.get(ref);
      if (!order || order.merchant_id !== AIRLINE_INFO.merchant_id) {
        return refuse("Unknown booking reference.");
      }
      if (order.status !== "confirmed") {
        return refuse("This booking is already cancelled.");
      }

      const bookedMs = timestampToMs(order.booked_at);
      const daysOut = (dateToMs(order.dates.start) - bookedMs) / MS_PER_DAY;
      if (daysOut < FLIGHT_MIN_DAYS_OUT) {
        return refuse(`Booked less than ${FLIGHT_MIN_DAYS_OUT} days before departure, so the 24-hour rule does not apply.`);
      }
      if (timestampToMs(now) > bookedMs + FLIGHT_FREE_CANCEL_HOURS * MS_PER_HOUR) {
        return refuse(
          `The ${FLIGHT_FREE_CANCEL_HOURS}-hour free cancellation window has closed. Changes are allowed for a ${formatMoney(FLIGHT_CHANGE_FEE)} fee.`,
        );
      }

      const refundId = await refundOrder(ctx, order, order.amount, `cancel-${order.ref}`);
      return { ok: true, refund_amount: order.amount, stripe_refund_id: refundId };
    },
  };
}
