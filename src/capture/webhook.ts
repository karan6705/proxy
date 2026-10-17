// POST /inkbox/inbound: Inkbox calls this for every email that reaches one of Proxy's task addresses.
import { createVerifier, type WebhookVerifier } from "../inkbox/verify.js";
import type { RouteHandler } from "../types.js";
import type { Capture } from "./capture.js";
import type { InboundEmail } from "./types.js";

/** The webhook body is wire-format snake_case; only the fields we read are listed. */
interface MailPayload {
  event_type?: string;
  data?: {
    message?: {
      id: string;
      message_id: string | null;
      from_address: string;
      to_addresses: string[];
      subject: string | null;
      snippet?: string | null;
      body?: string | null;
      body_truncated?: boolean | null;
      email_address?: string | null;
      direction?: string;
    };
  };
}

export interface FullMessage {
  html?: string;
  text?: string;
}

export interface InboundEmailRouteOptions {
  capture: Capture;
  /** Fetches the stored message for its HTML (the webhook only carries plain text). Returns null if unavailable. */
  fetchFullMessage?: (m: { id: string; email_address: string | null }) => Promise<FullMessage | null>;
  verify?: WebhookVerifier;
}

export function createInboundEmailRoute(opts: InboundEmailRouteOptions): RouteHandler {
  const verify = opts.verify ?? createVerifier();
  return {
    method: "POST",
    path: "/inkbox/inbound",
    async handle(req) {
      if (!(await verify(req.rawBody, req.headers))) return { status: 401, body: { ok: false, message: "bad signature" } };

      let payload: MailPayload;
      try {
        payload = JSON.parse(req.rawBody);
      } catch {
        return { status: 400, body: { ok: false, message: "invalid JSON" } };
      }
      const m = payload.data?.message;
      if (payload.event_type !== "message.received" || !m || m.direction === "outbound") {
        return { status: 200, body: { ok: true, ignored: payload.event_type ?? "unknown" } };
      }

      let full: FullMessage | null = null;
      try {
        full = (await opts.fetchFullMessage?.({ id: m.id, email_address: m.email_address ?? null })) ?? null;
      } catch {
        // Keep going with the plain text from the webhook; JSON-LD may be missing, so the LLM fallback can still run.
      }
      const email: InboundEmail = {
        message_id: m.message_id ?? m.id,
        from: m.from_address,
        to: m.to_addresses,
        subject: m.subject ?? "",
        text: full?.text ?? m.body ?? m.snippet ?? "",
        ...(full?.html ? { html: full.html } : {}),
      };
      const result = await opts.capture.handleEmail(email);
      // 200 even when nothing was captured, so Inkbox does not retry an email we deliberately dropped.
      return { status: 200, body: { ok: true, status: result.status } };
    },
  };
}
