// The demo feed: one time-ordered, plain-English timeline per task, for the stage page (GET /demo/feed).
// Entries are written as things happen. They never hold keys, tokens or phone numbers: the human is "human",
// and merchant free text is never copied in (only typed protocol fields).
import type { TaskId, Timestamp } from "../types.js";

export type FeedActor = "agent" | "proxy" | "human" | "hotel_agent" | "transfer_support" | "host" | "airline" | "stripe" | "store" | "carrier";

export type FeedKind =
  | "intent"
  | "booking"
  | "message"
  | "mismatch"
  | "self_undo"
  | "text_out"
  | "text_in"
  | "protocol_out"
  | "protocol_in"
  | "email_out"
  | "email_in"
  | "stripe_refund"
  | "chain"
  | "redo"
  /** Demo pacing: a visible "waiting for a reply…" or "verifying in Stripe…" before the next step lands. */
  | "wait"
  /** Proxy's plan for a chain after the human's reply: who it will contact, how, in what order. */
  | "plan"
  /** A merchant's return form: opened, each field Proxy filled in, submitted. */
  | "form_field"
  | "return_label"
  | "carrier_scan";

export interface FeedEntry {
  /** Order of arrival, which is time order. */
  seq: number;
  /** On the clock Proxy runs on (simulated in the demo). */
  at: Timestamp;
  task_id: TaskId;
  chain_id: string | null;
  actor: FeedActor;
  kind: FeedKind;
  /** One plain-English line, e.g. "Hotel agent: we can offer store credit of $640". */
  text: string;
  /** Structured fields for the page (amounts in cents, ids, protocol type and round). */
  data: Record<string, string | number | boolean | null>;
}

export interface Feed {
  add(entry: Omit<FeedEntry, "seq">): void;
  list(task_id: TaskId): FeedEntry[];
}

// E.164 (+14155550100) or a US-style 415-555-0100. Dates like 2026-11-13 don't match.
const PHONE = /\+\d{7,15}\b|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

/** Last line of defense: anything that looks like a phone number or a key never reaches the page. */
function scrub(text: string): string {
  return text.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "[key]").replace(/\bBearer\s+\S+/gi, "Bearer [token]").replace(PHONE, "[number]");
}

export function createFeed(limit = 500): Feed {
  const entries: FeedEntry[] = [];
  let seq = 0;
  return {
    add(entry) {
      const data: FeedEntry["data"] = {};
      for (const [k, v] of Object.entries(entry.data)) data[k] = typeof v === "string" ? scrub(v) : v;
      entries.push({ ...entry, text: scrub(entry.text), data, seq: ++seq });
      if (entries.length > limit) entries.shift();
    },
    list(task_id) {
      // Arrival order is time order: the clock only moves forward within a run.
      return entries.filter((e) => e.task_id === task_id);
    },
  };
}
