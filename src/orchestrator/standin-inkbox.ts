// Stand-in Inkbox, used until Sarah's src/inkbox/ merges. Records what would be sent; sends nothing.
import type { Inkbox, OutboundEmail, ProxyProtocolMessage } from "../types.js";

export const TASK_EMAIL_DOMAIN = "tasks.proxy.example";

export type Outbound =
  | { kind: "text"; channel: "sms" | "imessage"; to: string; body: string }
  | { kind: "call"; to: string; script: string }
  | { kind: "email"; email: OutboundEmail }
  | { kind: "protocol"; to_identity: string; message: ProxyProtocolMessage };

export function createStandInInkbox(): Inkbox & { readonly outbox: readonly Outbound[] } {
  const outbox: Outbound[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  return {
    outbox,
    async createTaskAddress(task_id) {
      return { task_email: `${task_id}@${TASK_EMAIL_DOMAIN}` };
    },
    async sendText(channel, to, body) {
      outbox.push({ kind: "text", channel, to, body });
      return { message_id: id("msg") };
    },
    async placeCall(to, script) {
      outbox.push({ kind: "call", to, script });
      return { call_id: id("call") };
    },
    async sendEmail(email) {
      outbox.push({ kind: "email", email });
      return { message_id: id("msg"), thread_id: email.thread_id ?? id("thread") };
    },
    async sendProtocolMessage(to_identity, message) {
      outbox.push({ kind: "protocol", to_identity, message });
      return { via: "email" };
    },
  };
}
