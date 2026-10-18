// What the mock merchants need from the outside world, and the shape every merchant module has.
// Karan wires `charge` and `refund` to Stripe test mode, and Sarah wires `deliver` to Inkbox (or straight to the
// capture webhook). src/merchants/fakes.ts has in-memory versions so each merchant works on its own.

import type {
  BookingRequest,
  CalendarDate,
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
  /**
   * The merchant this email is sent as. A real deliver (see inkbox-deliver.ts) uses it to pick the sending Inkbox
   * identity and its key. Set where the email is sent, not where it is written.
   */
  identity?: MerchantId;
}

export interface ChargeArgs {
  amount: Cents;
  merchant: MerchantId;
  task_id: TaskId;
  ref: string;
  description: string;
  idempotency_key: string;
}

/**
 * Merchants never refund. They agree a refund amount and return it; the orchestrator issues and verifies
 * the refund through Payments. So there is no refund here.
 */
export interface MerchantDeps {
  /** Stripe test-mode charge. Payments in types.ts has no charge(), so Karan backs this with src/stripe/charge.ts. */
  charge(args: ChargeArgs): Promise<{ charge_id: string }>;
  /** Sends a merchant email to the task address. Sarah backs this with Inkbox. */
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
  /** The refund the desk agreed to. 0 when it did not approve. The orchestrator issues it through Payments. */
  refund_amount: Cents;
  reply: MerchantEmail;
}

// ---- A merchant's return portal: a web form, then a label, then a carrier scan (Northwind Market) ----

export type ReturnFieldId = "order_number" | "item" | "reason" | "resolution" | "method";

export interface ReturnFormField {
  id: ReturnFieldId;
  label: string;
  kind: "text" | "choice";
  /** For a choice: the options. Proxy picks by `id`, never by the label's wording. */
  options?: Array<{ id: string; label: string }>;
}

export interface ReturnForm {
  title: string;
  url: string;
  fields: ReturnFormField[];
}

export interface ReturnLabel {
  rma: string;
  /** The order this return is for. */
  ref: string;
  carrier: string;
  drop_off_by: CalendarDate;
  drop_off_point: string;
  /** What the label's QR code encodes. */
  qr_payload: string;
}

export type ReturnSubmit = { ok: true; label: ReturnLabel } | { ok: false; errors: Partial<Record<ReturnFieldId, string>> };

export type ReturnReceipt = { approved: true; refund_amount: Cents; note?: string } | { approved: false; reason: string };

/** The simulated carrier tells the store a package was dropped off. Mocks only: nothing real is scanned. */
export interface CarrierScan {
  rma: string;
  ref: string;
  merchant_id: MerchantId;
  event: string;
  location: string;
}

export interface ReturnsPortal {
  form(): ReturnForm;
  submit(values: Partial<Record<ReturnFieldId, string>>, now: Timestamp): ReturnSubmit;
  /** The store's side once the carrier scan arrives: it agrees the refund (the orchestrator issues and verifies it). */
  receive(rma: string, now: Timestamp): ReturnReceipt;
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
  /** A web return form, when the merchant takes returns that way. */
  returns?: ReturnsPortal;
  /**
   * Simulated in this process only, on every server: its agent, emails, return form and carrier never go through
   * Inkbox (it has no Inkbox identity), even when the rest of the server uses real Inkbox.
   */
  in_process?: boolean;
  /** What the merchant would charge for an item, for a buying agent that orders again. */
  quote?(item: string): Cents | null;
}
