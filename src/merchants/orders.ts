// The merchants' own record of bookings, plus the booking flow all of them share:
// validate, charge, remember, and send the confirmation email.

import { dateToMs } from "../logic/dates.js";
import type { BookingResult, Cents, DateRange, MerchantId, MerchantInfo, TaskId, Timestamp } from "../types.js";
import type { BookInput, MerchantDeps, MerchantEmail } from "./deps.js";

/** The charge id of an order that cost nothing, such as a message. There is no Stripe charge to refund. */
export const NO_CHARGE = "no_charge";

export type MerchantErrorKind = "invalid_input" | "not_found" | "conflict" | "upstream_unavailable";

export class MerchantError extends Error {
  constructor(
    readonly kind: MerchantErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

/** cancelled: a refund was agreed. credited: store credit was agreed. corrected: a sent message was corrected. */
export type OrderStatus = "confirmed" | "cancelled" | "credited" | "corrected";

export interface MerchantOrder {
  ref: string;
  merchant_id: MerchantId;
  task_id: TaskId;
  task_email: string;
  item: string;
  dates: DateRange;
  amount: Cents;
  booked_at: Timestamp;
  charge_id: string;
  status: OrderStatus;
  /**
   * The refund the merchant agreed to. Merchants never move money: the orchestrator issues and verifies the
   * refund through Payments, using this amount.
   */
  refund_amount: Cents;
  confirmation_sent: boolean;
}

/** Small deterministic hash so refs look real but tests and replays are repeatable. */
function hash6(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

export class OrderBook {
  private readonly orders = new Map<string, MerchantOrder>();
  private sequence = 0;

  /** Every call gets a new ref, so booking the same thing twice gives two different bookings. */
  nextRef(prefix: string, seed: string): string {
    this.sequence += 1;
    return `${prefix}-${hash6(`${prefix}|${this.sequence}|${seed}`)}`;
  }

  add(order: MerchantOrder): void {
    if (this.orders.has(order.ref)) {
      throw new MerchantError("conflict", `Booking ${order.ref} already exists`);
    }
    this.orders.set(order.ref, order);
  }

  get(ref: string): MerchantOrder | null {
    return this.orders.get(ref) ?? null;
  }

  update(ref: string, patch: Partial<MerchantOrder>): MerchantOrder {
    const current = this.orders.get(ref);
    if (!current) {
      throw new MerchantError("not_found", `Unknown booking reference: ${ref}`);
    }
    const next = { ...current, ...patch };
    this.orders.set(ref, next);
    return next;
  }

  list(): MerchantOrder[] {
    return [...this.orders.values()];
  }
}

export interface ModuleContext {
  deps: MerchantDeps;
  orders: OrderBook;
}

export interface BookingSpec {
  info: MerchantInfo;
  ref_prefix: string;
  /** "single" needs dates.start. "range" also needs a dates.end after the start. "none": no dates (SaaS, store). */
  dates: "single" | "range" | "none";
  /** Messages cost nothing, so they may be booked for 0. Everything else needs a positive amount. */
  allow_zero_amount?: boolean;
  render(order: MerchantOrder): MerchantEmail;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function validate(spec: BookingSpec, request: BookInput): DateRange {
  const bad = (message: string): never => {
    throw new MerchantError("invalid_input", message);
  };
  if (request.merchant_id !== spec.info.merchant_id) {
    bad(`This booking is for ${request.merchant_id}, not ${spec.info.merchant_id}`);
  }
  if (typeof request.task_id !== "string" || request.task_id.length === 0) {
    bad("task_id is required");
  }
  if (typeof request.task_email !== "string" || !request.task_email.includes("@")) {
    bad("task_email must be an email address");
  }
  if (typeof request.item !== "string" || request.item.trim().length === 0) {
    bad("item is required");
  }
  const minimum = spec.allow_zero_amount ? 0 : 1;
  if (!Number.isInteger(request.amount) || request.amount < minimum) {
    bad(spec.allow_zero_amount ? "amount must be a whole number of cents, 0 or more" : "amount must be a positive whole number of cents");
  }
  if (typeof request.booked_at !== "string" || Number.isNaN(Date.parse(request.booked_at))) {
    bad("booked_at must be an ISO timestamp");
  }
  if (spec.dates === "none") {
    // The merchant keeps the booking date. The receipt itself carries no dates.
    return { start: request.booked_at.slice(0, 10) };
  }
  const dates = request.dates;
  if (!dates || !isCalendarDate(dates.start)) {
    return bad("dates.start must be a YYYY-MM-DD date");
  }
  if (spec.dates === "range" && (!isCalendarDate(dates.end) || dateToMs(dates.end) <= dateToMs(dates.start))) {
    return bad("dates.end must be a YYYY-MM-DD date after dates.start");
  }
  return dates;
}

/** Sends the confirmation email for a booking once. Returns false if it was already sent. */
export async function sendConfirmation(ctx: ModuleContext, spec: BookingSpec, ref: string): Promise<boolean> {
  const order = ctx.orders.get(ref);
  if (!order || order.merchant_id !== spec.info.merchant_id) {
    throw new MerchantError("not_found", `Unknown booking reference: ${ref}`);
  }
  if (order.confirmation_sent) {
    return false;
  }
  try {
    await ctx.deps.deliver({ ...spec.render(order), identity: spec.info.merchant_id });
  } catch (cause) {
    throw new MerchantError("upstream_unavailable", `Could not deliver the confirmation for ${ref}: ${errorMessage(cause)}`);
  }
  ctx.orders.update(ref, { confirmation_sent: true });
  return true;
}

/** Charges Stripe, records the order, and (unless deferred) emails the confirmation to the task address. */
export async function placeOrder(ctx: ModuleContext, spec: BookingSpec, request: BookInput): Promise<BookingResult> {
  const dates = validate(spec, request);
  const ref = ctx.orders.nextRef(spec.ref_prefix, `${request.task_id}|${request.item}|${request.booked_at}|${request.amount}`);

  let chargeId: string;
  if (request.amount === 0) {
    // Nothing to pay (a message), and Stripe rejects a zero charge.
    chargeId = NO_CHARGE;
  } else {
    try {
      const charge = await ctx.deps.charge({
        amount: request.amount,
        merchant: spec.info.merchant_id,
        task_id: request.task_id,
        ref,
        description: `${spec.info.name}: ${request.item}`,
        idempotency_key: `book-${ref}`,
      });
      chargeId = charge.charge_id;
    } catch (cause) {
      throw new MerchantError("upstream_unavailable", `Payment failed for ${ref}: ${errorMessage(cause)}`);
    }
  }

  ctx.orders.add({
    ref,
    merchant_id: spec.info.merchant_id,
    task_id: request.task_id,
    task_email: request.task_email,
    item: request.item,
    dates,
    amount: request.amount,
    booked_at: request.booked_at,
    charge_id: chargeId,
    status: "confirmed",
    refund_amount: 0,
    confirmation_sent: false,
  });

  if (!request.defer_confirmation) {
    await sendConfirmation(ctx, spec, ref);
  }
  return { ref, amount: request.amount, stripe_charge_id: chargeId };
}

/**
 * Records that the merchant agreed to refund `amount` and cancels the booking. No money moves here: the merchant
 * returns the agreed amount, and the orchestrator issues and verifies the refund through Payments.
 */
export function agreeRefund(ctx: ModuleContext, order: MerchantOrder, amount: Cents): MerchantOrder {
  return ctx.orders.update(order.ref, { status: "cancelled", refund_amount: amount });
}
