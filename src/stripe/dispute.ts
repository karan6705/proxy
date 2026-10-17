import type { Action, EvidencePacket, Intent, Mismatch, Timestamp } from "../types.js";
import { getStripeClient, type StripeParam, type StripeRequester } from "./client.js";

export interface StripeDisputeEvidence {
  customer_communication: string;
  customer_email_address: string;
  product_description: string;
  service_date?: string;
  uncategorized_text: string;
}

export interface DisputeChainEvidence {
  intent: Intent;
  order: Action;
  confirmation_excerpt: string;
  stripe_charge_id: string | null;
  mismatch: Mismatch;
  why_wrong: string;
  message_timeline: NonNullable<EvidencePacket["message_timeline"]>;
  deadline: Timestamp;
}

interface StripeDispute {
  id: string;
  charge: string | { id: string };
  status: string;
}

interface StripeList<T> {
  data: T[];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function buildDisputeEvidence(packet: EvidencePacket): StripeDisputeEvidence {
  const messageTimeline = packet.message_timeline ?? [];
  const audit = {
    order: packet.order,
    intent: packet.intent,
    stripe_charge_id: packet.stripe_charge_id,
    mismatch: packet.mismatch,
    why_wrong: packet.why_wrong,
    message_timeline: messageTimeline,
    deadline: packet.deadline,
  };

  return {
    customer_communication: truncate(
      [
        packet.confirmation_excerpt,
        ...messageTimeline.map((message) => `${message.at} ${message.direction} via ${message.channel}: ${message.summary}`),
      ].join("\n"),
      20_000,
    ),
    customer_email_address: truncate(packet.intent.task_email, 500),
    product_description: truncate(`${packet.order.category}: ${packet.order.summary} (${packet.order.ref})`, 5_000),
    service_date: packet.order.dates?.start,
    uncategorized_text: truncate(JSON.stringify(audit), 20_000),
  };
}

export function buildDisputePacket(chain: DisputeChainEvidence): EvidencePacket {
  if (!chain.mismatch.evidence) throw new Error("Dispute evidence requires receipt-backed mismatch evidence");
  if (chain.message_timeline.length === 0) throw new Error("Dispute evidence requires a message timeline");
  return {
    intent: chain.intent,
    order: chain.order,
    confirmation_excerpt: chain.confirmation_excerpt,
    stripe_charge_id: chain.stripe_charge_id,
    mismatch: chain.mismatch,
    why_wrong: chain.why_wrong,
    deadline: chain.deadline,
    message_timeline: chain.message_timeline,
  };
}

/**
 * Card disputes cannot be created by a merchant through Stripe's API. In test mode,
 * use a dispute-triggering payment method, then attach and submit this evidence.
 */
export async function submitDisputeEvidence(
  disputeId: string,
  packet: EvidencePacket,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<{ dispute_id: string }> {
  if (!idempotencyKey) throw new Error("An idempotency key is required to submit dispute evidence");
  const evidence = buildDisputeEvidence(packet);
  const params: Record<string, StripeParam> = { submit: true };
  for (const [key, value] of Object.entries(evidence)) params[`evidence[${key}]`] = value;
  const dispute = await client.request<StripeDispute>(
    "POST",
    `/v1/disputes/${encodeURIComponent(disputeId)}`,
    params,
    { idempotencyKey },
  );
  return { dispute_id: dispute.id };
}

export async function createDispute(
  chargeId: string,
  packet: EvidencePacket,
  idempotencyKey: string,
  client: StripeRequester = getStripeClient(),
): Promise<{ dispute_id: string }> {
  const disputes = await client.request<StripeList<StripeDispute>>("GET", "/v1/disputes", {
    charge: chargeId,
    limit: 1,
  });
  const dispute = disputes.data[0];
  if (!dispute) {
    throw new Error(`No Stripe dispute exists for charge ${chargeId}; use a test dispute payment method first`);
  }
  return submitDisputeEvidence(dispute.id, packet, idempotencyKey, client);
}
