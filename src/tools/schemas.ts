// Zod schemas for the six tools. Each one is checked against src/types.ts with `satisfies`,
// so a contract change that isn't mirrored here fails the typecheck.
import { z } from "zod";
import type {
  ChainActionView,
  DateRange,
  GetChainInput,
  GetChainOutput,
  IntentConstraints,
  ListChainsInput,
  ListChainsOutput,
  LogIntentInput,
  LogIntentOutput,
  Mismatch,
  Preferences,
  RedoInstruction,
  ReversibilityInput,
  ReversibilityOutput,
  ReviewInput,
  ReviewOutput,
  ToolError,
  UndoInput,
  UndoOutput,
} from "../types.js";

const taskId = z.string().regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores only");
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const timestamp = z.string().describe("ISO 8601 timestamp");
const cents = z.number().int().nonnegative().describe("Amount in USD cents, e.g. 41200 for $412");

const category = z.enum(["flight", "hotel", "transfer", "saas", "store", "message"]);
const nextAction = z
  .enum(["retry", "fix_now", "wait_for_human", "redo", "stop"])
  .describe("What the agent should do next");
const chainState = z.enum([
  "detected",
  "alerted",
  "undoing",
  "reversed",
  "redo_requested",
  "redone",
  "closed",
  "kept",
  "partial",
  "expired",
]);
const actionState = z.enum([
  "found",
  "planned",
  "requested",
  "accepted",
  "countered",
  "denied",
  "no_agent",
  "refund_pending",
  "verified",
  "failed",
  "kept",
]);
const route = z.enum(["reversal_protocol", "email_support", "self_serve", "correction", "stripe_dispute", "keep"]);

const dateRange = z.object({
  start: calendarDate,
  end: calendarDate.optional(),
}) satisfies z.ZodType<DateRange>;

const constraints = z.object({
  dates: dateRange.optional().describe("Dates the human asked for"),
  budget_total: cents.optional().describe("Total budget for the task"),
  destination: z.string().optional(),
  categories: z.array(category).optional().describe("Kinds of things the agent may buy"),
  must_haves: z.array(z.string()).optional(),
}) satisfies z.ZodType<IntentConstraints>;

const preferences = z.object({
  no_store_credit: z.boolean(),
  min_partial_refund_pct: z.number().min(0).max(100),
  auto_undo: z.boolean(),
}) satisfies z.ZodType<Preferences>;

const mismatchValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const mismatch = z.object({
  action_id: z.string(),
  field: z.enum(["dates", "amount", "term", "item", "duplicate"]),
  expected: mismatchValue,
  actual: mismatchValue,
  evidence: z
    .object({
      source_action_id: z.string(),
      receipt_fields: z.record(z.string(), mismatchValue),
    })
    .optional()
    .describe("The receipt this mismatch was read from"),
}) satisfies z.ZodType<Mismatch>;

const ok = z.literal(true);

// --- log_intent ---
export const logIntentInput = z.object({
  goal: z.string().min(1).describe('What the human asked for, in their words, e.g. "NYC trip for the Nov 13 conference, under $1,500"'),
  constraints,
  preferences: preferences.partial().optional().describe("The human's rules for fixes. Omit to use defaults"),
  idempotency_key: z.string().min(1).describe("Unique per task. Retrying with the same key returns the same task"),
  original_request: z
    .string()
    .max(2000)
    .optional()
    .describe("The human's request in their own words, if you have it. Proxy checks your dates and budget against it and asks the human if they differ"),
}) satisfies z.ZodType<LogIntentInput>;
export const logIntentOutput = z.object({
  ok,
  task_id: z.string(),
  task_email: z.string().describe("Use this email for every booking and signup in this task"),
  intent_check: z
    .object({
      status: z.enum(["agrees", "disagrees", "absent", "confirmed_human", "confirmed_agent"]),
      understood: z.string().optional(),
      said: z.string().optional(),
    })
    .optional()
    .describe("disagrees: your dates or budget differ from the human's words and the human is being asked. Wait, then call log_intent again with the same idempotency_key"),
  next_action: z.enum(["retry", "fix_now", "wait_for_human", "redo", "stop"]).optional(),
  constraints: constraints.optional().describe("The constraints to use, when the human's answer changed them"),
}) satisfies z.ZodType<LogIntentOutput & { ok: true }>;

// --- reversibility ---
export const reversibilityInput = z.object({
  merchant: z.string().describe("Merchant id, e.g. airline"),
  category,
  amount: cents,
  dates: dateRange.optional(),
}) satisfies z.ZodType<ReversibilityInput>;
export const reversibilityOutput = z.object({
  ok,
  kind: z.enum(["cancel_refund", "change", "return", "correct_message", "none"]),
  window_ends_at: timestamp.nullable(),
  refundable: z.boolean(),
  cost_to_reverse: cents,
  rule: z.string(),
}) satisfies z.ZodType<ReversibilityOutput & { ok: true }>;

// --- review ---
export const reviewInput = z.object({
  task_id: taskId,
}) satisfies z.ZodType<ReviewInput>;
export const reviewOutput = z.object({
  ok,
  status: z.enum(["clean", "chain_open"]),
  mismatches: z.array(mismatch),
  fixable_now: z.array(z.string()).describe("Action ids you may undo yourself with `undo`"),
  chain_ids: z.array(z.string()),
  evidence_seen: z.object({
    emails: z.number().int(),
    stripe_events: z.number().int(),
    actions: z.number().int(),
  }),
}) satisfies z.ZodType<ReviewOutput & { ok: true }>;

// --- undo ---
export const undoInput = z.object({
  action_ids: z.array(z.string()).min(1).describe("Action ids from review.fixable_now"),
  reason: z.string().min(1).describe("Why these actions are wrong, e.g. the mismatch"),
}) satisfies z.ZodType<UndoInput>;
export const undoOutput = z.object({
  ok,
  accepted: z.array(z.string()),
  requires_human: z.array(z.string()).describe("Not yours to undo; the human decides by text"),
  chain_id: z.string().nullable(),
}) satisfies z.ZodType<UndoOutput & { ok: true }>;

// --- get_chain ---
const chainActionView = z.object({
  action_id: z.string(),
  merchant: z.string(),
  category,
  summary: z.string(),
  amount: cents,
  state: actionState,
  route: route.nullable(),
  stripe_verified: z.boolean().describe("True only when Stripe shows the refund"),
}) satisfies z.ZodType<ChainActionView>;

const redoInstruction = z.object({
  task_id: z.string(),
  task_email: z.string(),
  corrected_intent: z.object({ goal: z.string(), constraints }),
  instruction: z.string(),
  redo_categories: z.array(category),
}) satisfies z.ZodType<RedoInstruction>;

export const getChainInput = z.object({
  chain_id: z.string(),
}) satisfies z.ZodType<GetChainInput>;
export const getChainOutput = z.object({
  ok,
  chain_id: z.string(),
  state: chainState,
  actions: z.array(chainActionView),
  money_at_risk: cents,
  window_ends_at: timestamp.nullable(),
  rounds: z.number().int(),
  redo: redoInstruction.optional().describe("Present once the chain is reversed: book this, using the task email"),
  next_action: nextAction,
}) satisfies z.ZodType<GetChainOutput & { ok: true }>;

// --- list_chains ---
export const listChainsInput = z.object({
  task_id: taskId.optional().describe("Omit to list open chains across all tasks"),
}) satisfies z.ZodType<ListChainsInput>;
export const listChainsOutput = z.object({
  ok,
  chains: z.array(
    z.object({
      chain_id: z.string(),
      task_id: z.string(),
      state: chainState,
      money_at_risk: cents,
      window_ends_at: timestamp.nullable(),
      action_count: z.number().int(),
      root_summary: z.string(),
    }),
  ),
}) satisfies z.ZodType<ListChainsOutput & { ok: true }>;

// --- error contract (returned with isError: true, so not part of outputSchema) ---
export const toolError = z.object({
  ok: z.literal(false),
  code: z.enum([
    "invalid_input",
    "not_found",
    "idempotency_conflict",
    "requires_human",
    "window_closed",
    "upstream_unavailable",
    "internal",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  next_action: nextAction,
}) satisfies z.ZodType<ToolError>;
