// Turns an inbound confirmation email into an Action for the right task, deduplicated by confirmation number.
import { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "../db/events.js";
import type { Action, ActionCategory, Clock, MerchantId, OrchestratorHooks, Store, TaskId } from "../types.js";
import { parseStructured } from "./structured.js";
import type { Extracted, Extraction, InboundEmail, LlmExtractor } from "./types.js";

/** Below this the LLM's answer is logged and dropped rather than raised as an Action. */
export const MIN_LLM_CONFIDENCE = 0.5;

export type CaptureResult =
  | { status: "captured"; action: Action; source: Extracted["source"]; confidence: number }
  | { status: "duplicate"; action: Action }
  | { status: "redelivered" }
  | { status: "no_task" }
  | { status: "unparseable" }
  | { status: "low_confidence"; confidence: number };

export interface CaptureDeps {
  store: Store;
  hooks: Pick<OrchestratorHooks, "onAction">;
  clock: Clock;
  llm?: LlmExtractor;
  /** Sender domain -> merchant id, e.g. { "skylinedemoair.example": "airline" }. */
  senderMerchants?: Record<string, MerchantId>;
  eventContext?: () => EventContext;
}

const DEFAULT_SENDERS: Record<string, MerchantId> = {
  "skylinedemoair.example": "airline",
  "harborviewhotel.example": "hotel",
  "metrotransfer.example": "transfer",
  "acmecloud.example": "saas",
};
const CATEGORY_FALLBACK: Partial<Record<ActionCategory, MerchantId>> = {
  flight: "airline",
  hotel: "hotel",
  transfer: "transfer",
  saas: "saas",
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const domainOf = (addr: string) => addr.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
const addressOf = (a: string) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim();

export function createCapture(deps: CaptureDeps) {
  const { store, hooks, clock } = deps;
  const senders = { ...DEFAULT_SENDERS, ...deps.senderMerchants };
  const ctx = () => (deps.eventContext ?? (() => DEMO_EVENT_CONTEXT))();
  const seenMessages = new Set<string>();

  /** The task is named by the recipient's local part (task_demo@...), ignoring a +tag, or a [task:ID] code in the subject. */
  async function findTask(email: InboundEmail): Promise<TaskId | null> {
    const candidates: string[] = [];
    for (const to of email.to) {
      const local = addressOf(to).split("@")[0].split("+")[0];
      // Inkbox handles are lowercase with hyphens, so task_demo lives at task-demo@...
      if (local) candidates.push(local, local.toLowerCase(), local.replace(/-/g, "_"), local.toLowerCase().replace(/-/g, "_"));
    }
    const code = email.subject.match(/\[task[:\s]+([A-Za-z0-9_-]+)\]/i)?.[1];
    if (code) candidates.push(code);
    for (const id of new Set(candidates)) {
      if (await store.getIntent(id)) return id;
    }
    return null;
  }

  async function extract(email: InboundEmail): Promise<Extracted | { low: number } | null> {
    for (const markup of [email.html, email.text]) {
      const found = markup ? parseStructured(markup) : null;
      if (found) return { ...found, confidence: 1 };
    }
    if (!deps.llm) return null;
    const guess = await deps.llm(email);
    if (!guess) return null;
    if (guess.confidence < MIN_LLM_CONFIDENCE) return { low: guess.confidence };
    return { extraction: guess.extraction, source: "llm", confidence: guess.confidence };
  }

  function merchantFor(email: InboundEmail, e: Extraction): MerchantId {
    const domain = domainOf(email.from);
    return (
      (domain && senders[domain]) ||
      CATEGORY_FALLBACK[e.category] ||
      (e.merchant_name && slug(e.merchant_name)) ||
      (domain && slug(domain.split(".")[0])) ||
      "unknown"
    );
  }

  async function handleEmail(email: InboundEmail): Promise<CaptureResult> {
    const now = clock.now();
    const log = (outcome: string, task_id: TaskId | null, action_id: string | null = null) =>
      store.logEvent(makeEvent(ctx(), now, { kind: "email_in", task_id, action_id, outcome }));

    if (email.message_id && seenMessages.has(email.message_id)) {
      await log("redelivered", null);
      return { status: "redelivered" };
    }
    const task_id = await findTask(email);
    if (!task_id) {
      await log("no_task", null);
      return { status: "no_task" };
    }
    if (email.message_id) seenMessages.add(email.message_id);

    const result = await extract(email);
    if (result && "low" in result) {
      await log("low_confidence", task_id);
      return { status: "low_confidence", confidence: result.low };
    }
    if (!result) {
      await log("unparseable", task_id);
      return { status: "unparseable" };
    }

    const { extraction: e } = result;
    const existing = (await store.listActions(task_id)).find((a) => a.ref === e.ref);
    if (existing) {
      await log("duplicate", task_id, existing.action_id);
      return { status: "duplicate", action: existing };
    }

    const action: Action = {
      action_id: `act_${task_id}_${slug(e.ref)}`,
      task_id,
      merchant: merchantFor(email, e),
      category: e.category,
      summary: e.summary,
      amount: e.amount,
      ...(e.dates ? { dates: e.dates } : {}),
      ref: e.ref,
      source: "email",
      received_at: now,
      state: "found",
    };
    await store.upsertAction(action);
    await log(`captured:${result.source}`, task_id, action.action_id);
    await hooks.onAction(action);
    return { status: "captured", action, source: result.source, confidence: result.confidence };
  }

  return { handleEmail };
}

export type Capture = ReturnType<typeof createCapture>;
