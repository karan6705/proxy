// Mock airport transfer company: no agent and no self-serve cancel. Customers email support. The support desk
// replies with a fixed, parseable format ("REFUND APPROVED" / "REFUND DENIED"), and refunds through Stripe when it
// approves. Free cancellation runs until 24 hours before pickup.

import { MS_PER_HOUR, dateToMs, timestampToMs } from "../logic/dates.js";
import { TRANSFER_FREE_CANCEL_HOURS } from "../logic/rules.js";
import type { MerchantInfo, SelfServeCancelResult } from "../types.js";
import type { MerchantEmail, MerchantModule, SupportEmail, SupportReply } from "./deps.js";
import { type AddressMode, MERCHANT_IDENTITIES, addressFor } from "./identities.js";
import { escapeHtml, formatDate, formatMoney, renderEmail } from "./emails.js";
import { taxiReservation } from "./jsonld.js";
import {
  type BookingSpec,
  type MerchantOrder,
  type ModuleContext,
  agreeRefund,
  placeOrder,
  sendConfirmation as sendOrderConfirmation,
} from "./orders.js";

export const TRANSFER_INFO: MerchantInfo = {
  merchant_id: "transfer",
  name: "Metro Transfer Co.",
  category: "transfer",
  has_agent: false,
  support_email: "support@metrotransfer.example",
};

const TELEPHONE = "+1-212-555-0177";
const PICKUP = "JFK Airport, Terminal 4, Arrivals";
const DROPOFF = "Harborview Hotel, 12 Pier Street, New York, NY";
const REF_PATTERN = /\bTRF-[A-Z0-9]{6}\b/;

function render(order: MerchantOrder, address: string, confirmationFrom: string) {
  return renderEmail({
    from: { name: TRANSFER_INFO.name, address: confirmationFrom },
    to: order.task_email,
    subject: `Transfer confirmed: ${formatDate(order.dates.start)} (${order.ref})`,
    heading: "Your airport transfer is confirmed",
    intro: `Thank you for booking with ${TRANSFER_INFO.name}. Your driver will meet you at arrivals.`,
    details: [
      ["Booking reference", order.ref],
      ["Service", order.item],
      ["Pickup", `${PICKUP}, ${formatDate(order.dates.start)}, 2:00 PM`],
      ["Drop-off", DROPOFF],
      ["Passengers", "1"],
      ["Total paid", formatMoney(order.amount)],
    ],
    footer: `Free cancellation until ${TRANSFER_FREE_CANCEL_HOURS} hours before pickup. To cancel, email ${address} with your booking reference.`,
    jsonld: taxiReservation(
      order,
      { name: TRANSFER_INFO.name, telephone: TELEPHONE, email: address },
      { pickup: PICKUP, dropoff: DROPOFF },
      "14:00",
    ),
  });
}

function replyEmail(to: string, subject: string, text: string, from: { name: string; address: string }): MerchantEmail {
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222">${text
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")}</body></html>`;
  return {
    from,
    to,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    body: text,
    html,
  };
}

export function createTransfer(ctx: ModuleContext, mode: AddressMode = "test"): MerchantModule {
  const address = addressFor(MERCHANT_IDENTITIES.transfer, mode);
  const info: MerchantInfo = { ...TRANSFER_INFO, support_email: address };
  const deskFrom = { name: `${TRANSFER_INFO.name} Support`, address };
  // Test mode keeps the separate bookings sender; the real identity sends everything from the one address.
  const confirmationFrom = mode === "real" ? address : "bookings@metrotransfer.example";
  const spec: BookingSpec = { info, ref_prefix: "TRF", dates: "single", render: (order) => render(order, address, confirmationFrom) };

  return {
    info,
    agent: null,

    book: (request) => placeOrder(ctx, spec, request),

    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: `No self-serve cancellation. Email ${address} with your booking reference.`,
      };
    },

    async handleSupportEmail(email: SupportEmail, now): Promise<SupportReply> {
      const decline = (ref: string | null, text: string): SupportReply => ({
        approved: false,
        ref,
        refund_amount: 0,
        reply: replyEmail(email.from, email.subject, text, deskFrom),
      });
      const approve = (ref: string, amount: number, intro: string): SupportReply => ({
        approved: true,
        ref,
        refund_amount: amount,
        reply: replyEmail(
          email.from,
          email.subject,
          `Hello,\n\nREFUND APPROVED: ${intro} ${formatMoney(amount)} will return to your original payment method.${signoff}`,
          deskFrom,
        ),
      });
      const signoff = `\n\n${TRANSFER_INFO.name} Support`;

      const found = `${email.subject}\n${email.body}`.match(REF_PATTERN);
      if (!found) {
        return decline(null, `Hello,\n\nWe could not find a booking reference in your message. Please reply with your reference (it looks like TRF-ABC123).${signoff}`);
      }
      const ref = found[0];

      const order = ctx.orders.get(ref);
      if (!order || order.merchant_id !== TRANSFER_INFO.merchant_id) {
        return decline(ref, `Hello,\n\nREFUND DENIED: we could not find booking ${ref}. Please check the reference and try again.${signoff}`);
      }
      // Idempotent: a second email about a booking already cancelled repeats the same approval and amount.
      if (order.status === "cancelled") {
        return approve(ref, order.refund_amount, `booking ${ref} is already cancelled and`);
      }
      if (order.status !== "confirmed") {
        return decline(ref, `Hello,\n\nREFUND DENIED: booking ${ref} cannot be cancelled.${signoff}`);
      }

      const cutoff = dateToMs(order.dates.start) - TRANSFER_FREE_CANCEL_HOURS * MS_PER_HOUR;
      if (timestampToMs(now) > cutoff) {
        return decline(
          ref,
          `Hello,\n\nREFUND DENIED: booking ${ref} is inside our ${TRANSFER_FREE_CANCEL_HOURS}-hour cancellation cutoff, so it can no longer be refunded.${signoff}`,
        );
      }

      // The desk agrees to the full refund. It does not touch Stripe: the orchestrator refunds and verifies.
      agreeRefund(ctx, order, order.amount);
      return approve(ref, order.amount, `booking ${ref} is cancelled and`);
    },
  };
}
