// A generic email support desk, for merchants that have no agent: someone emails with the booking reference, the desk
// looks the order up, decides, and replies in a fixed format ("REFUND APPROVED" or "REFUND DENIED").
// The desk only AGREES an amount. It never refunds: the orchestrator issues and verifies the refund through Payments.
// Asking again about an order already cancelled repeats the same approval, so a retry works.

import type { Cents, MerchantInfo, Timestamp } from "../types.js";
import type { MerchantEmail, SupportEmail, SupportReply } from "./deps.js";
import { escapeHtml, formatMoney } from "./emails.js";
import { type MerchantOrder, type ModuleContext, agreeRefund } from "./orders.js";

export type DeskDecision =
  | { approved: true; amount: Cents; note?: string }
  | { approved: false; reason: string };

export interface DeskSpec {
  ctx: ModuleContext;
  info: MerchantInfo;
  /** Who the replies come from. */
  from: { name: string; address: string };
  /** Finds the booking reference in an email, for example /\bSAS-[A-Z0-9]{6}\b/. */
  ref_pattern: RegExp;
  /** Shown when the reference is missing, for example "SAS-ABC123". */
  ref_example: string;
  /** The merchant's policy: what it agrees to refund, or why it refuses, at this time. */
  decide(order: MerchantOrder, now: Timestamp): DeskDecision;
}

export function replyEmail(from: { name: string; address: string }, to: string, subject: string, text: string): MerchantEmail {
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222">${text
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")}</body></html>`;
  return { from, to, subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`, body: text, html };
}

export function createSupportDesk(spec: DeskSpec): (email: SupportEmail, now: Timestamp) => Promise<SupportReply> {
  const signoff = `\n\n${spec.info.name} Support`;

  return async function handle(email: SupportEmail, now: Timestamp): Promise<SupportReply> {
    const reply = (approved: boolean, ref: string | null, refund_amount: Cents, text: string): SupportReply => ({
      approved,
      ref,
      refund_amount,
      reply: replyEmail(spec.from, email.from, email.subject, `Hello,\n\n${text}${signoff}`),
    });
    const approve = (ref: string, amount: Cents, intro: string, note = ""): SupportReply =>
      reply(true, ref, amount, `REFUND APPROVED: ${intro} ${formatMoney(amount)} will return to your original payment method.${note}`);

    const found = `${email.subject}\n${email.body}`.match(spec.ref_pattern);
    if (!found) {
      return reply(false, null, 0, `We could not find a reference in your message. Please reply with it (it looks like ${spec.ref_example}).`);
    }
    const ref = found[0];

    const order = spec.ctx.orders.get(ref);
    if (!order || order.merchant_id !== spec.info.merchant_id) {
      return reply(false, ref, 0, `REFUND DENIED: we could not find ${ref}. Please check the reference and try again.`);
    }
    if (order.status === "cancelled") {
      return approve(ref, order.refund_amount, `${ref} is already cancelled and`);
    }
    if (order.status !== "confirmed") {
      return reply(false, ref, 0, `REFUND DENIED: ${ref} cannot be cancelled.`);
    }

    const decision = spec.decide(order, now);
    if (!decision.approved) {
      return reply(false, ref, 0, `REFUND DENIED: ${decision.reason}`);
    }
    agreeRefund(spec.ctx, order, decision.amount);
    return approve(ref, decision.amount, `${ref} is cancelled and`, decision.note ? ` ${decision.note}` : "");
  };
}
