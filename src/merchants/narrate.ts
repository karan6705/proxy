// Readable one-line narration of the agent-to-agent part, for terminals and the demo video.
//
//   ← Proxy: reversal request for HTL-ABC123, wrong dates        (what the merchant received)
//   → Proxy: offering store credit $640.00                        (what the merchant sent back)
//
// This is display only. It never feeds a decision: negotiate_step reads the typed fields of a message, and the
// narration of a merchant message prefers the merchant's own `message` line, which is untrusted text and is only
// ever printed. Colors are plain ANSI and are off when NO_COLOR is set or the output is not a terminal.

import type { MerchantProtocolMessage, ProxyProtocolMessage } from "../types.js";
import type { SupportEmail, SupportReply } from "./deps.js";
import { formatMoney } from "./emails.js";

const MAX_TEXT = 140;

/** One line, no control characters, not too long. Merchant and Proxy text can be anything. */
export function oneLine(text: unknown, max = MAX_TEXT): string {
  const flat = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What the merchant received from Proxy, in plain words. */
export function narrateFromProxy(message: ProxyProtocolMessage): string {
  switch (message.type) {
    case "request_reversal":
      return `reversal request for ${oneLine(message.order.ref, 40)}, ${oneLine(message.what_went_wrong, 80)}`;
    case "push_back":
      return `push back: ${oneLine(message.reason, 100)}`;
    case "accept_counter":
      return "accepted your offer";
    case "ask_human":
      return "checking with the human";
    default:
      return "message";
  }
}

/** What the merchant sent back, in plain words. Uses the merchant's own readable line when it sent one. */
export function narrateToProxy(reply: MerchantProtocolMessage): string {
  const said = (reply as unknown as { message?: unknown }).message;
  if (typeof said === "string" && said.trim()) {
    return oneLine(said);
  }
  switch (reply.type) {
    case "counter":
      return reply.kind === "store_credit"
        ? `offering store credit ${formatMoney(reply.amount)}`
        : reply.kind === "partial_refund"
          ? `offering a partial refund, ${formatMoney(reply.amount)}`
          : `offering an exchange, ${formatMoney(reply.amount)}`;
    case "accept":
      return `refund agreed, ${formatMoney(reply.refund_amount)}`;
    case "deny":
      return `declined: ${oneLine(reply.reason, 100)}`;
  }
}

/** A support email received by a no-agent merchant's desk, and its reply. Two lines. */
export function narrateSupport(email: SupportEmail, reply: SupportReply): { received: string; replied: string } {
  const ref = reply.ref ?? "no reference";
  return {
    received: `support email "${oneLine(email.subject, 70)}" about ${ref}`,
    replied: reply.approved ? `refund approved, ${formatMoney(reply.refund_amount)} for ${ref}` : `refund declined for ${ref}`,
  };
}

export type Direction = "in" | "out";

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
} as const;

export function colorEnabled(env: NodeJS.ProcessEnv = process.env, isTty: boolean = Boolean(process.stdout?.isTTY)): boolean {
  return !("NO_COLOR" in env) && (isTty || env.FORCE_COLOR === "1");
}

/** "← Proxy: ..." for what came in, "→ Proxy: ..." for what went out. Red for a refusal, yellow for a push back. */
export function formatLine(direction: Direction, who: string, text: string, options: { color?: boolean; tone?: "deny" | "push" } = {}): string {
  const arrow = direction === "in" ? "←" : "→";
  if (!options.color) {
    return `${arrow} ${who}: ${text}`;
  }
  const tone = options.tone === "deny" ? CODES.red : options.tone === "push" ? CODES.yellow : direction === "in" ? CODES.cyan : CODES.green;
  return `${tone}${CODES.bold}${arrow} ${who}:${CODES.reset} ${tone}${text}${CODES.reset}`;
}

/** The two lines for one exchange on the hotel agent's terminal: what came in, then what it answered. */
export function narrateExchange(
  incoming: ProxyProtocolMessage,
  reply: MerchantProtocolMessage,
  options: { color?: boolean } = {},
): string[] {
  return [
    formatLine("in", "Proxy", narrateFromProxy(incoming), { ...options, tone: incoming.type === "push_back" ? "push" : undefined }),
    formatLine("out", "Proxy", narrateToProxy(reply), { ...options, tone: reply.type === "deny" ? "deny" : undefined }),
  ];
}
