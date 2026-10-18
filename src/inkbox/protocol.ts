// Strict readers for Reversal Protocol messages. Anything that arrives from a merchant is untrusted:
// only the typed fields below are copied into a fresh object; every other field and all free text is dropped.
import type { CounterKind, MerchantProtocolMessage, ProxyProtocolMessage, Timestamp } from "../types.js";

const ID = /^[A-Za-z0-9_.:\-]{1,128}$/;
const COUNTER_KINDS: readonly CounterKind[] = ["partial_refund", "store_credit", "exchange"];
const MAX_CENTS = 1_000_000_00;
const MAX_REASON = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_CENTS ? v : null);
// Drop control characters and cap the length; the reason is logged and shown, never acted on.
const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_REASON) : "");

/**
 * JSON from a string. Email bodies on Inkbox's free plan get a footer appended ("Sent via Inkbox"), so when a
 * straight parse fails, the outermost {...} is parsed instead. The fields are validated just as strictly after.
 */
function json(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function envelope(o: Record<string, unknown>, fallbackNow: Timestamp) {
  const { negotiation_id, chain_id, action_id, round, sent_at } = o;
  if (![negotiation_id, chain_id, action_id].every((v) => typeof v === "string" && ID.test(v))) return null;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > 3) return null;
  const when = typeof sent_at === "string" && !Number.isNaN(Date.parse(sent_at)) ? sent_at : fallbackNow;
  return { negotiation_id: negotiation_id as string, chain_id: chain_id as string, action_id: action_id as string, round, sent_at: when };
}

/** A merchant's answer: accept, counter or deny. Null for anything else. */
export function parseMerchantMessage(raw: unknown, now: Timestamp = new Date().toISOString()): MerchantProtocolMessage | null {
  const parsed = parseTypedMerchantMessage(raw, now);
  const o = json(raw);
  // The merchant's own one-line `message` rides along for display only (the show page). negotiate_step never acts
  // on it; it reads the typed fields and reports anything else as ignored text.
  if (!parsed || !isObj(o) || typeof o.message !== "string") return parsed;
  const line = clean(o.message).replace(/\s+/g, " ").trim().slice(0, 200);
  return line ? ({ ...parsed, message: line } as unknown as MerchantProtocolMessage) : parsed;
}

function parseTypedMerchantMessage(raw: unknown, now: Timestamp): MerchantProtocolMessage | null {
  const o = json(raw);
  if (!isObj(o)) return null;
  const env = envelope(o, now);
  if (!env) return null;
  if (o.type === "accept") {
    const refund_amount = cents(o.refund_amount);
    return refund_amount === null ? null : { ...env, type: "accept", refund_amount };
  }
  if (o.type === "counter") {
    const amount = cents(o.amount);
    const kind = COUNTER_KINDS.find((k) => k === o.kind);
    return amount === null || !kind ? null : { ...env, type: "counter", kind, amount };
  }
  if (o.type === "deny") return { ...env, type: "deny", reason: clean(o.reason) };
  return null;
}

/** What a merchant agent accepts from Proxy. Used by the merchant side of the bridge. */
export function parseProxyMessage(raw: unknown, now: Timestamp = new Date().toISOString()): ProxyProtocolMessage | null {
  const o = json(raw);
  if (!isObj(o)) return null;
  const env = envelope(o, now);
  if (!env) return null;
  if (o.type === "accept_counter") return { ...env, type: "accept_counter" };
  if (o.type === "push_back") return { ...env, type: "push_back", reason: clean(o.reason) };
  if (o.type === "request_reversal") {
    const order = o.order;
    const amount = isObj(order) ? cents(order.amount) : null;
    if (!isObj(order) || amount === null || typeof order.merchant !== "string" || typeof order.ref !== "string") return null;
    if (typeof o.what_went_wrong !== "string" || typeof o.deadline !== "string" || !isObj(o.intent) || !isObj(o.evidence)) return null;
    return {
      ...env,
      type: "request_reversal",
      order: { merchant: order.merchant, ref: order.ref, amount },
      intent: o.intent as never,
      what_went_wrong: clean(o.what_went_wrong),
      deadline: o.deadline,
      evidence: o.evidence as never,
    };
  }
  return null;
}

/** The JSON text out of an A2A message's parts: a text part holding JSON, or a data part. */
export function jsonFromParts(parts: readonly Record<string, unknown>[] | undefined): unknown {
  for (const part of parts ?? []) {
    if (typeof part.text === "string") {
      const parsed = json(part.text);
      if (parsed !== null) return parsed;
    }
    if (isObj(part.data)) return part.data;
  }
  return null;
}

/** Subject used when the protocol travels by email. */
export const protocolSubject = (type: string, negotiation_id: string) => `[proxy:${type}] ${negotiation_id}`;
export const isProtocolSubject = (subject: string | null | undefined) => /^\[proxy:[a-z_]+\]/.test(subject ?? "");
