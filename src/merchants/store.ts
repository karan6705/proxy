// Mock store: no agent. Returns are handled by email. Free returns for 30 days; from day 30 to day 60 a 15% restocking
// fee is taken from the refund; after day 60 there is no refund. The item (size and quantity included) is in the
// receipt's product name, for example "Rain jacket, size L" or "USB-C hub x10".

import { MS_PER_DAY, timestampToMs } from "../logic/dates.js";
import { STORE_LATE_RETURN_DAYS, STORE_RESTOCKING_FEE, STORE_RETURN_DAYS } from "../logic/rules.js";
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

export const STORE_INFO: MerchantInfo = {
  merchant_id: "store",
  name: "Northline Outfitters",
  category: "store",
  has_agent: false,
  support_email: "returns@northlineoutfitters.example",
};

const SELLER = { name: STORE_INFO.name, url: "https://northlineoutfitters.example" };

function render(order: MerchantOrder) {
  return renderEmail({
    from: { name: STORE_INFO.name, address: "orders@northlineoutfitters.example" },
    to: order.task_email,
    subject: `Order confirmed: ${order.item} (${order.ref})`,
    heading: "Your order is confirmed",
    intro: `Thanks for shopping with ${STORE_INFO.name}. We will email you when it ships.`,
    details: [
      ["Order number", order.ref],
      ["Item", order.item],
      ["Total charged", formatMoney(order.amount)],
    ],
    footer: `Free returns within ${STORE_RETURN_DAYS} days. A ${STORE_RESTOCKING_FEE * 100}% restocking fee applies from day ${STORE_RETURN_DAYS} to day ${STORE_LATE_RETURN_DAYS}. To start a return, email ${STORE_INFO.support_email} with your order number.`,
    jsonld: orderConfirmation(order, SELLER, { kind: "Product" }),
  });
}

export function createStore(ctx: ModuleContext): MerchantModule {
  const spec: BookingSpec = { info: STORE_INFO, ref_prefix: "STO", dates: "none", render };
  const from = { name: `${STORE_INFO.name} Returns`, address: STORE_INFO.support_email as string };

  return {
    info: STORE_INFO,
    agent: null,
    book: (request) => placeOrder(ctx, spec, request),
    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: `Returns are by email. Email ${STORE_INFO.support_email} with your order number.`,
      };
    },

    handleSupportEmail: createSupportDesk({
      ctx,
      info: STORE_INFO,
      from,
      ref_pattern: /\bSTO-[A-Z0-9]{6}\b/,
      ref_example: "STO-ABC123",
      decide(order, now) {
        const days = (timestampToMs(now) - timestampToMs(order.booked_at)) / MS_PER_DAY;
        if (days <= STORE_RETURN_DAYS) {
          return { approved: true, amount: order.amount };
        }
        if (days <= STORE_LATE_RETURN_DAYS) {
          const fee = Math.round(order.amount * STORE_RESTOCKING_FEE);
          return { approved: true, amount: order.amount - fee, note: `A ${STORE_RESTOCKING_FEE * 100}% restocking fee of ${formatMoney(fee)} was taken.` };
        }
        return { approved: false, reason: `the ${STORE_LATE_RETURN_DAYS}-day return window has closed.` };
      },
    }),
  };
}
