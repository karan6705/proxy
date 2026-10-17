import type { EvidencePacket } from "../types.js";
import { getStripeClient, type StripeParam, type StripeRequester } from "./client.js";

export interface StripeDisputeEvidence {
  customer_communication: string;
  customer_email_address: string;
  product_description: string;
  service_date?: string;
  uncategorized_text: string;
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
  const audit = {
    action_id: packet.order.action_id,
    task_id: packet.intent.task_id,
    merchant: packet.order.merchant,
    merchant_ref: packet.order.ref,
    stripe_charge_id: packet.stripe_charge_id,
    mismatch: packet.mismatch,
    why_wrong: packet.why_wrong,
    deadline: packet.deadline,
  };

  return {
    customer_communication: truncate(packet.confirmation_excerpt, 20_000),
    customer_email_address: truncate(packet.intent.task_email, 500),
    product_description: truncate(`${packet.order.category}: ${packet.order.summary} (${packet.order.ref})`, 5_000),
    service_date: packet.order.dates?.start,
    uncategorized_text: truncate(JSON.stringify(audit), 20_000),
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
