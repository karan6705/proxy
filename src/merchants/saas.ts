// Mock SaaS vendor: no agent. A subscription is cancelled by emailing billing; a full refund is agreed within 14 days
// of signup and nothing after. The receipt carries the billing term in the plan name ("billed annually", "monthly")
// and, when it is known, as an ISO duration (P1Y or P1M) in the schema.org markup.

import { MS_PER_DAY, timestampToMs } from "../logic/dates.js";
import { SAAS_REFUND_DAYS } from "../logic/rules.js";
import type { MerchantInfo, SelfServeCancelResult } from "../types.js";
import { createSupportDesk } from "./desk.js";
import type { MerchantModule } from "./deps.js";
import { formatMoney, renderEmail } from "./emails.js";
import { orderConfirmation } from "./jsonld.js";
import {
  type BookingSpec,
  type MerchantOrder,
  type ModuleContext,
  placeOrder,
  sendConfirmation as sendOrderConfirmation,
} from "./orders.js";

export const SAAS_INFO: MerchantInfo = {
  merchant_id: "saas",
  name: "Acme Cloud",
  category: "saas",
  has_agent: false,
  support_email: "billing@acmecloud.example",
};

const SELLER = { name: SAAS_INFO.name, url: "https://acmecloud.example" };

/** "billed annually" and the like -> P1Y; "monthly" -> P1M; otherwise unknown. */
function billingDuration(item: string): string | undefined {
  if (/\b(annual|annually|yearly|per year|12[- ]month)\b|\/\s*(?:yr|year)\b/i.test(item)) {
    return "P1Y";
  }
  if (/\b(monthly|per month)\b|\/\s*(?:mo|month)\b/i.test(item)) {
    return "P1M";
  }
  return undefined;
}

function render(order: MerchantOrder) {
  const duration = billingDuration(order.item);
  return renderEmail({
    from: { name: SAAS_INFO.name, address: SAAS_INFO.support_email as string },
    to: order.task_email,
    subject: `Your ${SAAS_INFO.name} subscription is active (${order.ref})`,
    heading: "Your subscription is active",
    intro: `Thanks for signing up with ${SAAS_INFO.name}. Your plan is active now.`,
    details: [
      ["Order number", order.ref],
      ["Plan", order.item],
      ["Total charged", formatMoney(order.amount)],
      ["Renewal", duration === "P1Y" ? "Renews every year until cancelled" : duration === "P1M" ? "Renews every month until cancelled" : "Renews until cancelled"],
    ],
    footer: `Full refund within ${SAAS_REFUND_DAYS} days of signup. To cancel, email ${SAAS_INFO.support_email} with your order number.`,
    jsonld: orderConfirmation(order, SELLER, { kind: "Service", billingDuration: duration }),
  });
}

export function createSaas(ctx: ModuleContext): MerchantModule {
  const spec: BookingSpec = { info: SAAS_INFO, ref_prefix: "SAS", dates: "none", render };
  const from = { name: `${SAAS_INFO.name} Billing`, address: SAAS_INFO.support_email as string };

  return {
    info: SAAS_INFO,
    agent: null,
    book: (request) => placeOrder(ctx, spec, request),
    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: `No self-serve cancellation. Email ${SAAS_INFO.support_email} with your order number.`,
      };
    },

    handleSupportEmail: createSupportDesk({
      ctx,
      info: SAAS_INFO,
      from,
      ref_pattern: /\bSAS-[A-Z0-9]{6}\b/,
      ref_example: "SAS-ABC123",
      decide(order, now) {
        const withinWindow = timestampToMs(now) <= timestampToMs(order.booked_at) + SAAS_REFUND_DAYS * MS_PER_DAY;
        return withinWindow
          ? { approved: true, amount: order.amount }
          : { approved: false, reason: `the ${SAAS_REFUND_DAYS}-day refund window has closed. Cancelling now only stops future charges.` };
      },
    }),
  };
}
