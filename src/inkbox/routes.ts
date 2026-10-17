// Inbound text and iMessage webhooks from Inkbox. Both go to the human channel, which checks the sender.
import type { RouteHandler } from "../types.js";
import type { HumanChannel } from "./human.js";
import { createVerifier, type WebhookVerifier } from "./verify.js";

interface TextPayload {
  event_type?: string;
  data?: { text_message?: { direction?: string; remote_phone_number?: string | null; text?: string | null } };
}
interface IMessagePayload {
  event_type?: string;
  data?: { message?: { direction?: string; remote_number?: string | null; content?: string | null } | null };
}

function route(path: string, verify: WebhookVerifier, extract: (raw: unknown) => { from: string; body: string } | null | "ignore", channel: HumanChannel, via: "sms" | "imessage"): RouteHandler {
  return {
    method: "POST",
    path,
    async handle(req) {
      if (!(await verify(req.rawBody, req.headers))) return { status: 401, body: { ok: false, message: "bad signature" } };
      let payload: unknown;
      try {
        payload = JSON.parse(req.rawBody);
      } catch {
        return { status: 400, body: { ok: false, message: "invalid JSON" } };
      }
      const msg = extract(payload);
      if (!msg || msg === "ignore") return { status: 200, body: { ok: true, ignored: true } };
      const result = await channel.handleInbound({ ...msg, via });
      return { status: 200, body: { ok: true, status: result.status } };
    },
  };
}

export function createHumanRoutes(channel: HumanChannel, verify: WebhookVerifier = createVerifier()): RouteHandler[] {
  return [
    route(
      "/inkbox/text",
      verify,
      (raw) => {
        const p = raw as TextPayload;
        const m = p.data?.text_message;
        if (p.event_type !== "text.received" || !m || m.direction === "outbound" || !m.remote_phone_number) return "ignore";
        return { from: m.remote_phone_number, body: m.text ?? "" };
      },
      channel,
      "sms",
    ),
    route(
      "/inkbox/imessage",
      verify,
      (raw) => {
        const p = raw as IMessagePayload;
        const m = p.data?.message;
        if (p.event_type !== "imessage.received" || !m || m.direction === "outbound" || !m.remote_number) return "ignore";
        return { from: m.remote_number, body: m.content ?? "" };
      },
      channel,
      "imessage",
    ),
  ];
}
