// schema.org confirmation markup, in the shapes email clients and Proxy's capture expect:
// FlightReservation, LodgingReservation, TaxiReservation. Amounts are dollar strings ("412.00").

import { dateToMs } from "../logic/dates.js";
import type { CalendarDate, JsonLdConfirmation } from "../types.js";
import { plainAmount } from "./emails.js";
import type { MerchantOrder } from "./orders.js";

const CONFIRMED = "https://schema.org/ReservationConfirmed";

/**
 * schema.org EmailMessage, for a message the agent sent (types.ts has no EmailMessage in JsonLdConfirmation).
 * The booking reference is `identifier`, since a message has no reservation number.
 */
export interface JsonLdMessage {
  "@context": "https://schema.org";
  "@type": "EmailMessage";
  identifier: string;
  [key: string]: unknown;
}

export function emailMessage(order: MerchantOrder, recipient: { name: string; email: string }): JsonLdMessage {
  return {
    "@context": "https://schema.org",
    "@type": "EmailMessage",
    identifier: order.ref,
    subject: order.item,
    dateSent: order.booked_at,
    sender: { "@type": "Person", email: order.task_email },
    toRecipient: { "@type": "Person", name: recipient.name, email: recipient.email },
    about: { "@type": "Event", name: "Arrival", startDate: order.dates.start },
  };
}

export type UsZone = "ET" | "PT";

function nthSunday(year: number, monthIndex: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return Date.UTC(year, monthIndex, firstSunday + (n - 1) * 7);
}

/** UTC offset for a US zone on a date. Approximate at the 2 AM switchover, which is fine for mock confirmations. */
export function usOffset(date: CalendarDate, zone: UsZone): string {
  const ms = dateToMs(date);
  const year = new Date(ms).getUTCFullYear();
  const dst = ms >= nthSunday(year, 2, 2) && ms < nthSunday(year, 10, 1);
  if (zone === "ET") {
    return dst ? "-04:00" : "-05:00";
  }
  return dst ? "-07:00" : "-08:00";
}

function traveler(order: MerchantOrder) {
  return { "@type": "Person", name: "Proxy task traveler", email: order.task_email };
}

export interface AirportInfo {
  code: string;
  name: string;
  zone: UsZone;
}

export function flightReservation(
  order: MerchantOrder,
  flight: {
    airline: { name: string; iataCode: string };
    flightNumber: string;
    from: AirportInfo;
    to: AirportInfo;
    departLocal: string;
    arriveLocal: string;
  },
): JsonLdConfirmation {
  const day = order.dates.start;
  return {
    "@context": "https://schema.org",
    "@type": "FlightReservation",
    reservationNumber: order.ref,
    reservationStatus: CONFIRMED,
    bookingTime: order.booked_at,
    underName: traveler(order),
    reservationFor: {
      "@type": "Flight",
      flightNumber: flight.flightNumber,
      airline: { "@type": "Airline", name: flight.airline.name, iataCode: flight.airline.iataCode },
      departureAirport: { "@type": "Airport", name: flight.from.name, iataCode: flight.from.code },
      departureTime: `${day}T${flight.departLocal}:00${usOffset(day, flight.from.zone)}`,
      arrivalAirport: { "@type": "Airport", name: flight.to.name, iataCode: flight.to.code },
      arrivalTime: `${day}T${flight.arriveLocal}:00${usOffset(day, flight.to.zone)}`,
    },
    totalPrice: plainAmount(order.amount),
    priceCurrency: "USD",
  };
}

export function lodgingReservation(
  order: MerchantOrder,
  hotel: { name: string; street: string; locality: string; region: string; postalCode: string; telephone: string },
  roomType: string,
): JsonLdConfirmation {
  const checkIn = order.dates.start;
  const checkOut = order.dates.end ?? order.dates.start;
  return {
    "@context": "https://schema.org",
    "@type": "LodgingReservation",
    reservationNumber: order.ref,
    reservationStatus: CONFIRMED,
    bookingTime: order.booked_at,
    underName: traveler(order),
    reservationFor: {
      "@type": "LodgingBusiness",
      name: hotel.name,
      telephone: hotel.telephone,
      address: {
        "@type": "PostalAddress",
        streetAddress: hotel.street,
        addressLocality: hotel.locality,
        addressRegion: hotel.region,
        postalCode: hotel.postalCode,
        addressCountry: "US",
      },
    },
    checkinTime: `${checkIn}T15:00:00${usOffset(checkIn, "ET")}`,
    checkoutTime: `${checkOut}T11:00:00${usOffset(checkOut, "ET")}`,
    lodgingUnitDescription: roomType,
    totalPrice: plainAmount(order.amount),
    priceCurrency: "USD",
  };
}

export function taxiReservation(
  order: MerchantOrder,
  provider: { name: string; telephone: string; email: string },
  route: { pickup: string; dropoff: string },
  pickupLocal: string,
): JsonLdConfirmation {
  const day = order.dates.start;
  return {
    "@context": "https://schema.org",
    "@type": "TaxiReservation",
    reservationNumber: order.ref,
    reservationStatus: CONFIRMED,
    bookingTime: order.booked_at,
    underName: traveler(order),
    reservationFor: {
      "@type": "Service",
      serviceType: "Airport transfer",
      provider: { "@type": "Organization", name: provider.name, telephone: provider.telephone, email: provider.email },
    },
    pickupLocation: { "@type": "Place", name: route.pickup },
    pickupTime: `${day}T${pickupLocal}:00${usOffset(day, "ET")}`,
    dropoffLocation: { "@type": "Place", name: route.dropoff },
    partySize: 1,
    totalPrice: plainAmount(order.amount),
    priceCurrency: "USD",
  };
}
