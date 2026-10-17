import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  EventRow,
  OrchestratorHooks,
  RouteHandler,
  Store,
  StripeEventKind,
  StripeEventRecord,
} from "../types.js";

interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface StripeEventContext {
  run_id: string;
  arm: EventRow["arm"];
  scenario_id: string;
  layer: EventRow["layer"];
}

export interface StripeWebhookOptions {
  store: Pick<Store, "logEvent">;
  hooks?: Pick<OrchestratorHooks, "onStripeEvent">;
  webhookSecret?: string;
  context: StripeEventContext | (() => StripeEventContext);
  toleranceSeconds?: number;
  now?: () => number;
}

const SUPPORTED_EVENTS = new Set<StripeEventKind>([
  "charge.succeeded",
  "charge.refunded",
  "refund.updated",
  "charge.dispute.created",
]);

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

function numberField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  return typeof value === "number" ? value : 0;
}

function metadata(object: Record<string, unknown>): Record<string, string> {
  const value = object.metadata;
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function signatureParts(header: string): { timestamp: number; signatures: string[] } {
  const values = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = Number(values.find(([key]) => key === "t")?.[1]);
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value).filter(Boolean);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) throw new Error("Malformed Stripe-Signature header");
  return { timestamp, signatures };
}

export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!webhookSecret.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET must begin with whsec_");
  const { timestamp, signatures } = signatureParts(signatureHeader);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new Error("Stripe webhook timestamp is outside tolerance");
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const valid = signatures.some((signature) => {
    if (!/^[a-f\d]{64}$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) throw new Error("Invalid Stripe webhook signature");
}

export function toStripeEventRecord(event: StripeWebhookEvent): StripeEventRecord | null {
  if (!SUPPORTED_EVENTS.has(event.type as StripeEventKind)) return null;
  const object = event.data.object;
  const meta = metadata(object);
  const isRefund = event.type === "refund.updated";
  const isDispute = event.type === "charge.dispute.created";
  const chargeId = isRefund || isDispute ? stringField(object, "charge") : stringField(object, "id");
  if (!chargeId) return null;
  const refundSucceeded = isRefund && object.status === "succeeded";

  return {
    stripe_event_id: event.id,
    kind: event.type as StripeEventKind,
    task_id: meta.task_id ?? null,
    charge_id: chargeId,
    amount: numberField(object, "amount"),
    refunded_amount: isRefund
      ? refundSucceeded
        ? numberField(object, "amount")
        : 0
      : numberField(object, "amount_refunded"),
    merchant: meta.merchant ?? null,
    at: new Date(event.created * 1000).toISOString(),
  };
}

export function toEventRow(event: StripeWebhookEvent, record: StripeEventRecord, context: StripeEventContext): EventRow {
  const meta = metadata(event.data.object);
  return {
    ...context,
    kind: "stripe_event",
    tool_name: null,
    task_id: record.task_id,
    chain_id: meta.chain_id ?? null,
    action_id: meta.action_id ?? null,
    outcome: `${record.kind}:${record.stripe_event_id}`,
    tokens_in: null,
    tokens_out: null,
    timestamp: record.at,
  };
}

export function createStripeWebhookHandler(options: StripeWebhookOptions): RouteHandler {
  const webhookSecret = options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  return {
    method: "POST",
    path: "/webhooks/stripe",
    async handle(req) {
      const signature = Object.entries(req.headers).find(([key]) => key.toLowerCase() === "stripe-signature")?.[1];
      if (!signature) return { status: 400, body: { ok: false, error: "Missing Stripe-Signature header" } };

      try {
        verifyStripeSignature(
          req.rawBody,
          signature,
          webhookSecret,
          options.toleranceSeconds,
          Math.floor((options.now?.() ?? Date.now()) / 1000),
        );
        const event = JSON.parse(req.rawBody) as StripeWebhookEvent;
        const record = toStripeEventRecord(event);
        if (record) {
          const context = typeof options.context === "function" ? options.context() : options.context;
          await options.store.logEvent(toEventRow(event, record, context));
          await options.hooks?.onStripeEvent(record);
        }
        return { status: 200, body: { received: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Stripe webhook";
        return { status: 400, body: { ok: false, error: message } };
      }
    },
  };
}

export const stripeWebhookHandler = createStripeWebhookHandler;
