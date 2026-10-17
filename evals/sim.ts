// A small simulator for the evals and the demo fixtures. It books through the real mock merchants with in-memory
// Stripe and email, then reads each confirmation email back into an Action the way capture will: from the
// schema.org JSON-LD block. So a fixture or scenario cannot drift from what the merchants really send.
//
// This is a reference extractor for tests. The real one is Sarah's src/capture/.

import {
  type FakeDeps,
  type HotelAgentOptions,
  type MerchantEmail,
  type MerchantsImpl,
  createFakeDeps,
  createMerchants,
} from "../src/merchants/index.js";
import type { Action, Cents, DateRange, MerchantId, StripeEventRecord, TaskId, Timestamp } from "../src/types.js";

/** Capture reads a confirmation this long after it is sent. */
export const CAPTURE_DELAY_MS = 5 * 60 * 1000;

export interface SimBooking {
  /** Short id: "flight" becomes the action id "act_flight". */
  id: string;
  merchant_id: MerchantId;
  item: string;
  dates: DateRange;
  amount: Cents;
  booked_at: Timestamp;
  /** The confirmation arrives later than the booking, after the agent has left. */
  confirm_at?: Timestamp;
}

export interface SimWorld {
  merchants: MerchantsImpl;
  fake: FakeDeps;
  actions: Action[];
  stripe_events: StripeEventRecord[];
  /** The confirmation emails, keyed by booking id, in the order they were sent. */
  emails: { id: string; email: MerchantEmail }[];
}

type JsonLd = Record<string, any>;

export function parseJsonLd(html: string): JsonLd {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("No schema.org JSON-LD block found in the email");
  }
  return JSON.parse(match[1]);
}

const datePart = (isoLocal: string): string => isoLocal.slice(0, 10);

function nightsBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** What capture does with one confirmation: schema.org JSON-LD in, Action out. */
export function actionFromJsonLd(
  ld: JsonLd,
  meta: { action_id: string; task_id: TaskId; merchant: MerchantId; received_at: Timestamp },
): Action {
  const common = { action_id: meta.action_id, task_id: meta.task_id, merchant: meta.merchant, received_at: meta.received_at, state: "found" as const };
  const cents = (price: unknown): Cents => Math.round(Number.parseFloat(String(price ?? "0")) * 100);

  switch (ld["@type"]) {
    case "FlightReservation": {
      const flight = ld.reservationFor;
      return {
        ...common,
        category: "flight",
        summary: `Flight ${flight.departureAirport.iataCode} to ${flight.arrivalAirport.iataCode}`,
        amount: cents(ld.totalPrice),
        dates: { start: datePart(flight.departureTime) },
        ref: ld.reservationNumber,
        source: "email",
      };
    }
    case "LodgingReservation": {
      const start = datePart(ld.checkinTime);
      const end = datePart(ld.checkoutTime);
      return {
        ...common,
        category: "hotel",
        summary: `${ld.reservationFor.name}, ${nightsBetween(start, end)} nights`,
        amount: cents(ld.totalPrice),
        dates: { start, end },
        ref: ld.reservationNumber,
        source: "email",
      };
    }
    case "TaxiReservation":
      return {
        ...common,
        category: "transfer",
        summary: `Airport transfer, ${ld.pickupLocation.name} to ${ld.dropoffLocation.name}`,
        amount: cents(ld.totalPrice),
        dates: { start: datePart(ld.pickupTime) },
        ref: ld.reservationNumber,
        source: "email",
      };
    case "EmailMessage":
      return {
        ...common,
        category: "message",
        summary: String(ld.subject),
        amount: 0,
        dates: { start: String(ld.about.startDate) },
        ref: ld.identifier,
        source: "agent",
      };
    default:
      throw new Error(`Unsupported schema.org type: ${String(ld["@type"])}`);
  }
}

/** The ref inside an email's JSON-LD: a reservation number, or the identifier of a message. */
function refOf(ld: JsonLd): string {
  return String(ld.reservationNumber ?? ld.identifier);
}

export async function simulateBookings(options: {
  task_id: TaskId;
  task_email: string;
  bookings: SimBooking[];
  hotel?: HotelAgentOptions;
}): Promise<SimWorld> {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps, { hotel: options.hotel });
  const ordered = [...options.bookings].sort((a, b) => Date.parse(a.booked_at) - Date.parse(b.booked_at));

  const refById = new Map<string, string>();
  for (const booking of ordered) {
    const { ref } = await merchants.book({
      merchant_id: booking.merchant_id,
      task_id: options.task_id,
      task_email: options.task_email,
      item: booking.item,
      dates: booking.dates,
      amount: booking.amount,
      booked_at: booking.booked_at,
      defer_confirmation: booking.confirm_at !== undefined,
    });
    refById.set(booking.id, ref);
  }

  // Late confirmations go out after the agent has left, in the order they arrive.
  const late = ordered.filter((b) => b.confirm_at !== undefined).sort((a, b) => Date.parse(a.confirm_at as string) - Date.parse(b.confirm_at as string));
  for (const booking of late) {
    await merchants.sendConfirmation(booking.merchant_id, refById.get(booking.id) as string);
  }

  const emailsByRef = new Map(fake.emails.map((email) => [refOf(parseJsonLd(email.html)), email]));
  const emails = ordered.map((booking) => ({ id: booking.id, email: emailsByRef.get(refById.get(booking.id) as string) as MerchantEmail }));

  const actions = ordered.map((booking, index) => {
    const arrivedAt = Date.parse(booking.confirm_at ?? booking.booked_at) + CAPTURE_DELAY_MS;
    return actionFromJsonLd(parseJsonLd(emails[index].email.html), {
      action_id: `act_${booking.id}`,
      task_id: options.task_id,
      merchant: booking.merchant_id,
      received_at: new Date(arrivedAt).toISOString(),
    });
  });

  const stripe_events: StripeEventRecord[] = fake.charges.map((charge, index) => ({
    stripe_event_id: `evt_test_${index + 1}`,
    kind: "charge.succeeded",
    task_id: options.task_id,
    charge_id: charge.charge_id,
    amount: charge.amount,
    refunded_amount: 0,
    merchant: charge.args.merchant,
    at: ordered.find((b) => refById.get(b.id) === charge.args.ref)?.booked_at ?? ordered[0].booked_at,
  }));

  return { merchants, fake, actions, stripe_events, emails };
}
