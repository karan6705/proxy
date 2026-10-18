// Turns the demo feed into the StageFeed that Sarah's stage page (/web/stage) reads from GET /demo/feed.
import type { StageBooking, StageConversation, StageConversationEntry, StageEntryKind, StageFeed, StageHumanEntry, StageRow } from "../web/stage-feed.js";
import type { Action, Intent, Timestamp } from "../types.js";
import type { FeedEntry } from "./feed.js";

export interface StageChainInput {
  chain_id: string;
  state: string;
  window_ends_at: Timestamp | null;
  rows: Array<{ action: Action; label: string; recovered: number; verified: boolean }>;
}

const CONVERSATION_NAME: Record<string, string> = { hotel: "Harborview Hotel agent", transfer: "Metro Transfer desk", host: "Host" };
const PROTOCOL_KIND: Record<string, StageEntryKind> = {
  request_reversal: "request",
  counter: "counter",
  push_back: "push_back",
  accept_counter: "accept_counter",
  accept: "accept",
  deny: "deny",
};

/** "Harborview Hotel agent: we can offer…" -> "We can offer…": the bubble already names the speaker. */
function bubbleText(text: string): string {
  const t = text.replace(/^[^:]{1,48}:\s+/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `flagged` adds actions compare flags now (late confirmations arrive after the agent's last review). */
export function toStageFeed(
  task_id: string,
  now: Timestamp,
  intent: Intent | null,
  entries: FeedEntry[],
  chain: StageChainInput | null,
  labels: Record<string, string>,
  flagged: Iterable<string> = [],
  via = "Stripe",
): StageFeed {
  const wrong = new Set([...entries.filter((e) => e.kind === "mismatch").map((e) => String(e.data.action_id)), ...flagged]);
  const bookings: StageBooking[] = entries
    .filter((e) => e.kind === "booking" || e.kind === "message" || e.kind === "redo")
    .map((e) => {
      const id = String(e.data.action_id);
      const start = e.data.start ? String(e.data.start) : null;
      const end = e.data.end ? String(e.data.end) : null;
      return {
        id,
        merchant: String(e.data.merchant),
        category: e.data.category as StageBooking["category"],
        summary: labels[id] ?? e.text,
        amount: Number(e.data.amount ?? 0),
        ...(start ? { dates: { start, ...(end ? { end } : {}) } } : {}),
        at: e.at,
        wrong: wrong.has(id),
      };
    });

  const human: StageHumanEntry[] = entries
    .filter((e) => e.kind === "text_out" || e.kind === "text_in")
    .map((e) => ({
      at: e.at,
      direction: e.kind === "text_out" ? ("out" as const) : ("in" as const),
      channel: (e.data.channel ?? e.data.via ?? "imessage") === "sms" ? ("sms" as const) : ("imessage" as const),
      text: e.kind === "text_in" ? e.text.replace(/^Human:\s*/, "") : e.text,
    }));

  const byMerchant = new Map<string, StageConversationEntry[]>();
  const add = (merchant: string, entry: StageConversationEntry) => byMerchant.set(merchant, [...(byMerchant.get(merchant) ?? []), entry]);
  for (const e of entries) {
    const merchant = e.data.merchant ? String(e.data.merchant) : null;
    if (!merchant || merchant === "airline") continue; // the flight is self-serve: no conversation
    if (e.kind === "protocol_out" || e.kind === "protocol_in") {
      add(merchant, { at: e.at, from: e.kind === "protocol_out" ? "proxy" : "merchant", kind: PROTOCOL_KIND[String(e.data.type)] ?? "reply", text: bubbleText(e.text) });
    } else if (e.kind === "email_out") {
      add(merchant, { at: e.at, from: "proxy", kind: e.data.correction ? "correction" : "email", text: bubbleText(e.text) });
    } else if (e.kind === "email_in") {
      add(merchant, { at: e.at, from: "merchant", kind: "reply", text: bubbleText(e.text) });
    } else if (e.kind === "stripe_refund") {
      add(merchant, { at: e.at, from: "stripe", kind: "stripe", text: `Refund confirmed in ${via} · $${Math.round(Number(e.data.amount) / 100).toLocaleString("en-US")}` });
    }
  }
  const order = ["hotel", "transfer", "host"];
  const conversations: StageConversation[] = [...byMerchant.entries()]
    .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(([merchant, list]) => ({ with: merchant, name: CONVERSATION_NAME[merchant] ?? merchant, entries: list }));

  let stageChain: StageFeed["chain"] = null;
  if (chain) {
    const rows: StageRow[] = chain.rows.map((r) => ({
      id: r.action.action_id,
      label: r.label,
      amount: r.action.amount,
      state: r.action.state,
      refunded: r.recovered,
      verified: r.verified,
    }));
    stageChain = {
      chain_id: chain.chain_id,
      state: chain.state,
      window_ends_at: chain.window_ends_at,
      total: rows.reduce((t, r) => t + r.amount, 0),
      recovered: rows.reduce((t, r) => t + (r.verified ? r.refunded : 0), 0),
      rows,
    };
  }

  return {
    task_id,
    now,
    task: intent
      ? {
          goal: intent.goal,
          ...(intent.constraints.dates ? { intended_dates: intent.constraints.dates } : {}),
          ...(intent.constraints.budget_total !== undefined ? { budget_total: intent.constraints.budget_total } : {}),
        }
      : { goal: "" },
    bookings,
    chain: stageChain,
    human,
    conversations,
  };
}
