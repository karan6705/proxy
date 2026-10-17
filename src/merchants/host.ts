// Mock host: a person the agent emailed ("I arrive Nov 3") who Proxy later corrects ("I mean Nov 13").
//
// The agent's message is a booking that costs nothing: it is recorded with a MSG-XXXXXX reference, and a copy goes to
// the task address with schema.org EmailMessage markup (the reference is `identifier`). The host has no agent and no
// self-serve cancel, because a sent message cannot be unsent. It only takes a correction by email and acknowledges it.
// A correction moves no money, so the agreed refund is always 0.

import { formatDate, renderEmail } from "./emails.js";
import { emailMessage } from "./jsonld.js";
import type { MerchantInfo, SelfServeCancelResult } from "../types.js";
import type { MerchantEmail, MerchantModule, SupportEmail, SupportReply } from "./deps.js";
import {
  type BookingSpec,
  type MerchantOrder,
  type ModuleContext,
  placeOrder,
  sendConfirmation as sendOrderConfirmation,
} from "./orders.js";

export const HOST_INFO: MerchantInfo = {
  merchant_id: "host",
  name: "Alex Rivera (host)",
  category: "message",
  has_agent: false,
  support_email: "alex.rivera@example.com",
};

const FROM = { name: HOST_INFO.name, address: "alex.rivera@example.com" };
const COPY_FROM = { name: "Your agent (copy of a sent message)", address: "agent-copy@tasks.proxy.example" };
const REF_PATTERN = /\bMSG-[A-Z0-9]{6}\b/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function render(order: MerchantOrder) {
  return renderEmail({
    from: COPY_FROM,
    to: order.task_email,
    subject: `Copy of your message to ${HOST_INFO.name}: ${order.item} (${order.ref})`,
    heading: "Your message was sent",
    intro: `A copy of the message your agent sent to ${HOST_INFO.name}.`,
    details: [
      ["Reference", order.ref],
      ["To", `${HOST_INFO.name} <${HOST_INFO.support_email}>`],
      ["Message", order.item],
      ["Arrival date given", formatDate(order.dates.start)],
    ],
    footer: "If the message turns out to be wrong, Proxy can send the host a correction.",
    jsonld: emailMessage(order, { name: HOST_INFO.name, email: HOST_INFO.support_email as string }),
  });
}

function replyEmail(to: string, subject: string, text: string): MerchantEmail {
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222">${text
    .split("\n\n")
    .map((paragraph) => `<p>${paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
    .join("")}</body></html>`;
  return { from: FROM, to, subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`, body: text, html };
}

export function createHost(ctx: ModuleContext): MerchantModule {
  const spec: BookingSpec = { info: HOST_INFO, ref_prefix: "MSG", dates: "single", allow_zero_amount: true, render };

  return {
    info: HOST_INFO,
    agent: null,

    book: (request) => placeOrder(ctx, spec, request),

    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: "A sent message cannot be cancelled. Send the host a correction instead.",
      };
    },

    /** A correction email from Proxy. The host acknowledges it; nothing is refunded, so refund_amount is 0. */
    async handleSupportEmail(email: SupportEmail): Promise<SupportReply> {
      const signoff = `\n\n${HOST_INFO.name}`;
      const decline = (ref: string | null, text: string): SupportReply => ({
        approved: false,
        ref,
        refund_amount: 0,
        reply: replyEmail(email.from, email.subject, `Hi,\n\n${text}${signoff}`),
      });

      const found = `${email.subject}\n${email.body}`.match(REF_PATTERN);
      if (!found) {
        return decline(null, "Which message are you correcting? Please include its reference (it looks like MSG-ABC123).");
      }
      const ref = found[0];
      const order = ctx.orders.get(ref);
      if (!order || order.merchant_id !== HOST_INFO.merchant_id) {
        return decline(ref, `I could not find a message with reference ${ref}.`);
      }

      // Idempotent: a repeated correction is acknowledged again and changes nothing.
      if (order.status !== "corrected") {
        ctx.orders.update(order.ref, { status: "corrected" });
      }
      const newDate = email.body.match(ISO_DATE)?.[0];
      const plans = newDate ? `I have updated my plans for ${formatDate(newDate)}` : "I have updated my plans";
      return {
        approved: true,
        ref,
        refund_amount: 0,
        reply: replyEmail(
          email.from,
          email.subject,
          `Hi,\n\nThanks for letting me know about the mix-up with ${ref}. ${plans}.${signoff}`,
        ),
      };
    },
  };
}
