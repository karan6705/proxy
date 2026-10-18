// Mock hotel with its own agent. The rate is non-refundable, so the only way out is a goodwill refund negotiated
// over the Reversal Protocol. The default behavior is the demo: counter with store credit, then, once Proxy pushes
// back, counter with an 85% partial refund, and refund that on accept_counter. At most three rounds are ever needed.
// The agent only ever replies with typed protocol messages, never free text.

import { MS_PER_HOUR, dateToMs, timestampToMs } from "../logic/dates.js";
import { HOTEL_NEGOTIATION_CUTOFF_HOURS } from "../logic/rules.js";
import type {
  AcceptMsg,
  Cents,
  CounterKind,
  CounterMsg,
  DenyMsg,
  MerchantAgent,
  MerchantInfo,
  MerchantProtocolMessage,
  ProtocolEnvelope,
  ProxyProtocolMessage,
  SelfServeCancelResult,
  Timestamp,
} from "../types.js";
import type { MerchantModule } from "./deps.js";
import { type AddressMode, MERCHANT_IDENTITIES, addressFor } from "./identities.js";
import { formatDate, formatMoney, nightsBetween, renderEmail } from "./emails.js";
import { lodgingReservation } from "./jsonld.js";
import {
  type BookingSpec,
  type MerchantOrder,
  type ModuleContext,
  agreeRefund,
  placeOrder,
  sendConfirmation as sendOrderConfirmation,
} from "./orders.js";

export const HOTEL_INFO: MerchantInfo = {
  merchant_id: "hotel",
  name: "Harborview Hotel",
  category: "hotel",
  has_agent: true,
  agent_identity: "hotel-agent",
  support_email: "reservations@harborviewhotel.example",
};

const ADDRESS = { street: "12 Pier Street", locality: "New York", region: "NY", postalCode: "10004", telephone: "+1-212-555-0142" };
const ROOM = "Standard King Room";

/**
 * credit_then_partial: store credit first, then a partial refund after one push back (the demo).
 * accept_full: refunds everything straight away. deny: refuses.
 */
export type HotelBehavior = "credit_then_partial" | "accept_full" | "deny";

export interface HotelAgentOptions {
  behavior?: HotelBehavior;
  /** Share of the price offered as the partial refund. Default 85. */
  partial_refund_pct?: number;
  /**
   * For testing prompt injection: adds this text to every reply as an extra `note` field that is not part of the
   * protocol, like a merchant trying to talk Proxy into something. Proxy must read only the typed fields.
   */
  inject_text?: string;
}

type Phase = "credit_offered" | "partial_offered" | "closed";

interface Negotiation {
  ref: string;
  phase: Phase;
  offer: { kind: CounterKind; amount: Cents };
}

function render(order: MerchantOrder, address: string) {
  const checkOut = order.dates.end ?? order.dates.start;
  const nights = nightsBetween(order.dates.start, checkOut);
  return renderEmail({
    from: { name: HOTEL_INFO.name, address },
    to: order.task_email,
    subject: `Your reservation at ${HOTEL_INFO.name} is confirmed (${order.ref})`,
    heading: "Your reservation is confirmed",
    intro: `Thank you for choosing ${HOTEL_INFO.name}. We look forward to welcoming you.`,
    details: [
      ["Confirmation number", order.ref],
      ["Hotel", `${HOTEL_INFO.name}, ${ADDRESS.street}, ${ADDRESS.locality}, ${ADDRESS.region} ${ADDRESS.postalCode}`],
      ["Check-in", `${formatDate(order.dates.start)}, from 3:00 PM`],
      ["Check-out", `${formatDate(checkOut)}, by 11:00 AM`],
      ["Stay", `${nights} night${nights === 1 ? "" : "s"}, ${ROOM}`],
      ["Rate", "Advance purchase, non-refundable"],
      ["Total paid", formatMoney(order.amount)],
    ],
    footer: `This rate is non-refundable. Our reservations team can consider goodwill requests until ${HOTEL_NEGOTIATION_CUTOFF_HOURS} hours before check-in.`,
    jsonld: lodgingReservation(order, { name: HOTEL_INFO.name, ...ADDRESS }, ROOM),
  });
}

function envelope(message: ProxyProtocolMessage, now: Timestamp): ProtocolEnvelope {
  return {
    negotiation_id: message.negotiation_id,
    chain_id: message.chain_id,
    action_id: message.action_id,
    round: message.round,
    sent_at: now,
  };
}

function createHotelAgent(ctx: ModuleContext, options: HotelAgentOptions): MerchantAgent {
  const behavior = options.behavior ?? "credit_then_partial";
  const partialPct = options.partial_refund_pct ?? 85;
  const negotiations = new Map<string, Negotiation>();

  const accept = (message: ProxyProtocolMessage, now: Timestamp, refund_amount: Cents): AcceptMsg => ({
    ...envelope(message, now),
    type: "accept",
    refund_amount,
  });
  const counter = (message: ProxyProtocolMessage, now: Timestamp, kind: CounterKind, amount: Cents): CounterMsg => ({
    ...envelope(message, now),
    type: "counter",
    kind,
    amount,
  });
  const deny = (message: ProxyProtocolMessage, now: Timestamp, reason: string): DenyMsg => ({
    ...envelope(message, now),
    type: "deny",
    reason,
  });

  /** With inject_text set, tacks the extra untrusted field onto a reply. */
  const tag = (reply: MerchantProtocolMessage): MerchantProtocolMessage =>
    options.inject_text ? ({ ...reply, note: options.inject_text } as unknown as MerchantProtocolMessage) : reply;

  return {
    merchant_id: HOTEL_INFO.merchant_id,

    async respond(message, now): Promise<MerchantProtocolMessage> {
      return tag(await respondTo(message, now));
    },
  };

  async function respondTo(message: ProxyProtocolMessage, now: Timestamp): Promise<MerchantProtocolMessage> {
    {
      switch (message.type) {
        case "request_reversal": {
          const order = ctx.orders.get(message.order.ref);
          if (!order || order.merchant_id !== HOTEL_INFO.merchant_id) {
            return deny(message, now, "Unknown booking reference.");
          }
          if (order.status !== "confirmed") {
            return deny(message, now, "This booking has already been refunded or cancelled.");
          }
          const cutoff = dateToMs(order.dates.start) - HOTEL_NEGOTIATION_CUTOFF_HOURS * MS_PER_HOUR;
          if (timestampToMs(now) > cutoff) {
            return deny(message, now, "Too close to check-in for a goodwill refund.");
          }
          if (behavior === "deny") {
            return deny(message, now, "Non-refundable rate: our policy does not allow refunds.");
          }
          if (behavior === "accept_full") {
            agreeRefund(ctx, order, order.amount);
            return accept(message, now, order.amount);
          }
          const offer = { kind: "store_credit" as const, amount: order.amount };
          negotiations.set(message.negotiation_id, { ref: order.ref, phase: "credit_offered", offer });
          return counter(message, now, offer.kind, offer.amount);
        }

        case "push_back": {
          const negotiation = negotiations.get(message.negotiation_id);
          const order = negotiation ? ctx.orders.get(negotiation.ref) : null;
          if (!negotiation || !order || negotiation.phase === "closed") {
            return deny(message, now, "No open negotiation.");
          }
          if (negotiation.phase === "credit_offered") {
            negotiation.phase = "partial_offered";
            negotiation.offer = { kind: "partial_refund", amount: Math.round((order.amount * partialPct) / 100) };
          }
          // Asked again after the partial offer: the same offer stands.
          return counter(message, now, negotiation.offer.kind, negotiation.offer.amount);
        }

        case "accept_counter": {
          const negotiation = negotiations.get(message.negotiation_id);
          const order = negotiation ? ctx.orders.get(negotiation.ref) : null;
          if (!negotiation || !order || negotiation.phase === "closed") {
            return deny(message, now, "No open negotiation.");
          }
          negotiation.phase = "closed";
          if (negotiation.offer.kind === "store_credit") {
            // Store credit moves no money, so the agreed refund is 0.
            ctx.orders.update(order.ref, { status: "credited", refund_amount: 0 });
            return accept(message, now, 0);
          }
          // The hotel agrees to the partial refund. The orchestrator issues and verifies it through Payments.
          agreeRefund(ctx, order, negotiation.offer.amount);
          return accept(message, now, negotiation.offer.amount);
        }

        case "ask_human": {
          // Proxy is waiting on the human. The standing offer is unchanged.
          const negotiation = negotiations.get(message.negotiation_id);
          if (!negotiation || negotiation.phase === "closed") {
            return deny(message, now, "No open negotiation.");
          }
          return counter(message, now, negotiation.offer.kind, negotiation.offer.amount);
        }
      }
    }
  }
}

export function createHotel(ctx: ModuleContext, options: HotelAgentOptions = {}, mode: AddressMode = "test"): MerchantModule {
  const address = addressFor(MERCHANT_IDENTITIES.hotel, mode);
  const info: MerchantInfo = { ...HOTEL_INFO, support_email: address };
  const spec: BookingSpec = { info, ref_prefix: "HTL", dates: "range", render: (order) => render(order, address) };

  return {
    info,
    agent: createHotelAgent(ctx, options),
    handleSupportEmail: null,

    book: (request) => placeOrder(ctx, spec, request),

    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: "Non-refundable rate. Request a goodwill refund through the hotel's reversal agent.",
      };
    },
  };
}
