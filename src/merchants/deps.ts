// What the mock merchants need from the outside world, and the shape every merchant module has.
// Karan wires `charge` and `refund` to Stripe test mode, and Sarah wires `deliver` to Inkbox (or straight to the
// capture webhook). src/merchants/fakes.ts has in-memory versions so each merchant works on its own.

import type {
  BookingRequest,
  BookingResult,
  Cents,
  MerchantAgent,
  MerchantId,
  MerchantInfo,
  OutboundEmail,
  SelfServeCancelResult,
  TaskId,
  Timestamp,
} from "../types.js";

/** A confirmation or support reply from a merchant. `html` carries the schema.org JSON-LD block. */
export interface MerchantEmail extends OutboundEmail {
  from: { name: string; address: string };
  html: string;
}

export interface ChargeArgs {
  amount: Cents;
  merchant: MerchantId;
  task_id: TaskId;
  ref: string;
  description: string;
  idempotency_key: string;
}

export interface MerchantDeps {
  /** Stripe test-mode charge. Payments in types.ts has no charge(), so this is requested in HANDOFF.md. */
  charge(args: ChargeArgs): Promise<{ charge_id: string }>;
  /** Same signature as Payments.refund. */
  refund(charge_id: string, amount: Cents, idempotency_key: string): Promise<{ refund_id: string }>;
  /** Sends a merchant email to the task address. */
  deliver(email: MerchantEmail): Promise<void>;
}

/** BookingRequest plus a switch for late confirmations (the confirmation is sent later with sendConfirmation). */
export type BookInput = BookingRequest & { defer_confirmation?: boolean };

export interface SupportEmail {
  from: string;
  subject: string;
  body: string;
}

export interface SupportReply {
  approved: boolean;
  /** The booking reference found in the email, if any. */
  ref: string | null;
  refund_amount: Cents;
  stripe_refund_id: string | null;
  reply: MerchantEmail;
}

export interface MerchantModule {
  info: MerchantInfo;
  book(request: BookInput): Promise<BookingResult>;
  /** Sends the confirmation for a deferred booking. Returns false if it was already sent. */
  sendConfirmation(ref: string): Promise<boolean>;
  selfServeCancel(ref: string, now: Timestamp): Promise<SelfServeCancelResult>;
  /** The merchant agent, when the merchant has one. */
  agent: MerchantAgent | null;
  /** Email support, when the merchant has a support desk and no agent. */
  handleSupportEmail: ((email: SupportEmail, now: Timestamp) => Promise<SupportReply>) | null;
}
