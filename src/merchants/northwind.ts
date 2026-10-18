// Northwind Market: a mock online store with a support agent and a web return form. Built on the store's return
// policy (free returns for 30 days, a 15% restocking fee until day 60), but this one answers Proxy over the Reversal
// Protocol instead of by email.
//
// What the support agent does when Proxy asks it to reverse an order: offer an exchange or store credit (typed as
// a store_credit counter); when Proxy pushes back for a refund, say that refunds go through the return form (typed
// as a deny). The return form then takes the order number, item, reason, resolution and return method, and gives
// back an RMA number and a return label with a QR code. The refund is agreed when the (simulated) carrier scans the
// package at drop-off. Like every merchant here it only agrees an amount; the orchestrator issues and verifies the
// refund through Payments. The decision is always in the typed fields; the persona's one-line `message` is for people.

import { MS_PER_DAY, timestampToMs } from "../logic/dates.js";
import { STORE_LATE_RETURN_DAYS, STORE_RESTOCKING_FEE, STORE_RETURN_DAYS } from "../logic/rules.js";
import type {
  AcceptMsg,
  Cents,
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
import type { CarrierScan, MerchantModule, ReturnFieldId, ReturnForm, ReturnReceipt, ReturnSubmit, ReturnsPortal } from "./deps.js";
import { formatMoney, renderEmail } from "./emails.js";
import { orderConfirmation } from "./jsonld.js";
import { type BookingSpec, type MerchantOrder, type ModuleContext, agreeRefund, placeOrder, sendConfirmation as sendOrderConfirmation } from "./orders.js";

export const NORTHWIND_INFO: MerchantInfo = {
  merchant_id: "northwind",
  name: "Northwind Market",
  category: "store",
  has_agent: true,
  agent_identity: "northwind-agent",
  support_email: "support@northwindmarket.example",
};

const SELLER = { name: NORTHWIND_INFO.name, url: "https://northwindmarket.example" };
const FORM_URL = "northwindmarket.example/returns";
const CARRIER = "ParcelPoint";
const DROP_OFF_POINT = "any ParcelPoint locker or counter";
/** A label is good for this many days. */
export const RETURN_LABEL_DAYS = 14;

/** What Northwind sells, by name. A buying agent that orders again pays these prices. */
export const NORTHWIND_CATALOG: ReadonlyArray<{ name: string; price: Cents }> = [
  { name: "USB-A 20W charger", price: 4_500 },
  { name: "USB-C 65W charger", price: 5_200 },
  { name: "USB-C 100W charger", price: 7_900 },
  { name: "USB-C to USB-C cable, 2 m", price: 1_800 },
];

const norm = (text: string | undefined) => (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const RESOLUTIONS = [
  { id: "refund_original", label: "Refund to original payment" },
  { id: "store_credit", label: "Store credit" },
  { id: "exchange", label: "Exchange for another item" },
];
const METHODS = [
  { id: "drop_off", label: "Drop-off" },
  { id: "pickup", label: "Home pickup" },
];

const FORM: ReturnForm = {
  title: "Start a return",
  url: FORM_URL,
  fields: [
    { id: "order_number", label: "Order number", kind: "text" },
    { id: "item", label: "Item", kind: "text" },
    { id: "reason", label: "Reason for return", kind: "text" },
    { id: "resolution", label: "Resolution", kind: "choice", options: RESOLUTIONS },
    { id: "method", label: "Return method", kind: "choice", options: METHODS },
  ],
};

function render(order: MerchantOrder) {
  return renderEmail({
    from: { name: NORTHWIND_INFO.name, address: "orders@northwindmarket.example" },
    to: order.task_email,
    subject: `Order confirmed: ${order.item} (${order.ref})`,
    heading: "Your order is confirmed",
    intro: `Thanks for shopping with ${NORTHWIND_INFO.name}. We will email you when it ships.`,
    details: [
      ["Order number", order.ref],
      ["Item", order.item],
      ["Total charged", formatMoney(order.amount)],
    ],
    footer: `Free returns within ${STORE_RETURN_DAYS} days. Start a return at ${FORM_URL}.`,
    jsonld: orderConfirmation(order, SELLER, { kind: "Product" }),
  });
}

function envelope(message: ProxyProtocolMessage, now: Timestamp): ProtocolEnvelope {
  return { negotiation_id: message.negotiation_id, chain_id: message.chain_id, action_id: message.action_id, round: message.round, sent_at: now };
}

const say = <T extends MerchantProtocolMessage>(reply: T, line: string): MerchantProtocolMessage => ({ ...reply, message: line }) as unknown as MerchantProtocolMessage;

function createAgent(ctx: ModuleContext): MerchantAgent {
  const open = new Map<string, { ref: string; credit: Cents }>();
  const counter = (m: ProxyProtocolMessage, now: Timestamp, amount: Cents): CounterMsg => ({ ...envelope(m, now), type: "counter", kind: "store_credit", amount });
  const deny = (m: ProxyProtocolMessage, now: Timestamp, reason: string): DenyMsg => ({ ...envelope(m, now), type: "deny", reason });
  const accept = (m: ProxyProtocolMessage, now: Timestamp, refund_amount: Cents): AcceptMsg => ({ ...envelope(m, now), type: "accept", refund_amount });

  return {
    merchant_id: NORTHWIND_INFO.merchant_id,

    async respond(message, now): Promise<MerchantProtocolMessage> {
      switch (message.type) {
        case "request_reversal": {
          const order = ctx.orders.get(message.order.ref);
          if (!order || order.merchant_id !== NORTHWIND_INFO.merchant_id) return deny(message, now, "Unknown order number.");
          if (order.status !== "confirmed") return deny(message, now, "This order has already been returned or refunded.");
          const days = (timestampToMs(now) - timestampToMs(order.booked_at)) / MS_PER_DAY;
          if (days > STORE_LATE_RETURN_DAYS) return deny(message, now, "The return window has closed.");
          open.set(message.negotiation_id, { ref: order.ref, credit: order.amount });
          return say(counter(message, now, order.amount), `We can exchange it for the item you meant, or give ${formatMoney(order.amount)} in store credit.`);
        }

        case "push_back": {
          if (!open.has(message.negotiation_id)) return deny(message, now, "No open request.");
          open.delete(message.negotiation_id);
          // Refunds are not the support agent's to give: they go through the return form, and nothing else.
          return say(deny(message, now, "Refunds go through the return form."), `Refunds to the original payment go through our return form at ${FORM_URL}.`);
        }

        case "accept_counter": {
          const negotiation = open.get(message.negotiation_id);
          const order = negotiation ? ctx.orders.get(negotiation.ref) : null;
          if (!negotiation || !order) return deny(message, now, "No open request.");
          open.delete(message.negotiation_id);
          ctx.orders.update(order.ref, { status: "credited", refund_amount: 0 });
          return say(accept(message, now, 0), `Store credit of ${formatMoney(negotiation.credit)} issued. Nothing goes back to the card.`);
        }

        case "ask_human": {
          const negotiation = open.get(message.negotiation_id);
          if (!negotiation) return deny(message, now, "No open request.");
          return say(counter(message, now, negotiation.credit), "Our offer stands while you check with your customer.");
        }
      }
    },
  };
}

interface ReturnRecord {
  ref: string;
  drop_off_by: string;
  scanned: boolean;
}

function createPortal(ctx: ModuleContext): ReturnsPortal & { scan(rma: string): CarrierScan | null } {
  const returns = new Map<string, ReturnRecord>();

  return {
    form: () => FORM,

    submit(values, now): ReturnSubmit {
      const errors: Partial<Record<ReturnFieldId, string>> = {};
      for (const field of FORM.fields) {
        const value = values[field.id]?.trim();
        if (!value) errors[field.id] = "Required.";
        else if (field.kind === "choice" && !field.options?.some((o) => o.id === value)) errors[field.id] = "Pick one of the options.";
      }
      const order = values.order_number ? ctx.orders.get(values.order_number.trim()) : null;
      if (values.order_number?.trim() && (!order || order.merchant_id !== NORTHWIND_INFO.merchant_id)) errors.order_number = "We could not find that order.";
      if (order && order.merchant_id === NORTHWIND_INFO.merchant_id) {
        if (values.item?.trim() && norm(values.item) !== norm(order.item)) errors.item = "That item is not on this order.";
        if (order.status !== "confirmed") errors.order_number = "This order has already been returned or refunded.";
        else if ((timestampToMs(now) - timestampToMs(order.booked_at)) / MS_PER_DAY > STORE_LATE_RETURN_DAYS) errors.order_number = "The return window has closed.";
        if ((values.reason?.length ?? 0) > 300) errors.reason = "Please keep it under 300 characters.";
      }
      if (Object.keys(errors).length || !order) return { ok: false, errors };

      const rma = ctx.orders.nextRef("RMA", `${order.ref}|${now}`);
      const drop_off_by = new Date(timestampToMs(now) + RETURN_LABEL_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
      returns.set(rma, { ref: order.ref, drop_off_by, scanned: false });
      return {
        ok: true,
        label: { rma, ref: order.ref, carrier: CARRIER, drop_off_by, drop_off_point: DROP_OFF_POINT, qr_payload: `NWM|${rma}|${order.ref}` },
      };
    },

    receive(rma, now): ReturnReceipt {
      const record = returns.get(rma);
      const order = record ? ctx.orders.get(record.ref) : null;
      if (!record || !order) return { approved: false, reason: "Unknown return." };
      if (!record.scanned) return { approved: false, reason: "The package has not been scanned yet." };
      if (order.status === "cancelled") return { approved: true, refund_amount: order.refund_amount };
      if (timestampToMs(now) > Date.parse(`${record.drop_off_by}T23:59:59.999Z`)) return { approved: false, reason: "The label has expired." };
      // The late fee is the store's policy, and it is taken from the refund, as the store module does.
      const days = (timestampToMs(now) - timestampToMs(order.booked_at)) / MS_PER_DAY;
      const fee = days > STORE_RETURN_DAYS ? Math.round(order.amount * STORE_RESTOCKING_FEE) : 0;
      const refund_amount = order.amount - fee;
      agreeRefund(ctx, order, refund_amount);
      return { approved: true, refund_amount, ...(fee ? { note: `A restocking fee of ${formatMoney(fee)} was taken.` } : {}) };
    },

    scan(rma) {
      const record = returns.get(rma);
      if (!record) return null;
      record.scanned = true;
      return { rma, ref: record.ref, merchant_id: NORTHWIND_INFO.merchant_id, event: "Package scanned at drop-off", location: "ParcelPoint drop-off" };
    },
  };
}

export interface NorthwindOptions {
  /** Called with each scan the simulated carrier produces. */
  onScan?: (scan: CarrierScan) => void;
  /** How long after the label the simulated carrier scans the package. Undefined: never on its own. */
  scan_delay_ms?: number;
  /** Moves a simulated clock to the drop-off day (a day after the label) just before the scan. */
  advance?: (ms: number) => void;
}

export function createNorthwind(ctx: ModuleContext, options: NorthwindOptions = {}): MerchantModule {
  const spec: BookingSpec = { info: NORTHWIND_INFO, ref_prefix: "NWM", dates: "none", render };
  const portal = createPortal(ctx);
  const returns: ReturnsPortal = {
    form: portal.form,
    receive: portal.receive,
    submit(values, now) {
      const result = portal.submit(values, now);
      if (result.ok && options.scan_delay_ms !== undefined) {
        const rma = result.label.rma;
        const timer = setTimeout(() => {
          options.advance?.(MS_PER_DAY);
          const scan = portal.scan(rma);
          if (scan) options.onScan?.(scan);
        }, options.scan_delay_ms);
        timer.unref?.();
      }
      return result;
    },
  };

  return {
    info: NORTHWIND_INFO,
    agent: createAgent(ctx),
    handleSupportEmail: null,
    returns,
    quote: (item) => NORTHWIND_CATALOG.find((p) => norm(p.name) === norm(item))?.price ?? null,
    book: (request) => placeOrder(ctx, spec, request),
    sendConfirmation: (ref) => sendOrderConfirmation(ctx, spec, ref),

    async selfServeCancel(): Promise<SelfServeCancelResult> {
      return {
        ok: false,
        refund_amount: 0,
        stripe_refund_id: null,
        reason: `Returns go through the return form at ${FORM_URL}, or the support agent.`,
      };
    },
  };
}
