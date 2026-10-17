// Shared contracts for Proxy. Source of truth: docs/04-architecture.md.
// Types only. Only Karan edits this file; after the freeze, changes need all three people.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 8601 timestamp, e.g. "2026-11-03T08:00:00.000Z". Always from the Clock, never Date.now(). */
export type Timestamp = string;

/** Calendar date, "YYYY-MM-DD". */
export type CalendarDate = string;

/** Money in the smallest currency unit (USD cents), matching Stripe. $412 is 41200. */
export type Cents = number;

export interface DateRange {
  start: CalendarDate;
  /** Omit for single-day actions. */
  end?: CalendarDate;
}

/** Lowercase letters, digits and underscores only (TASK_ID_PATTERN): a task id becomes an Inkbox handle. */
export type TaskId = string;
export type ActionId = string;
export type ChainId = string;
export type NegotiationId = string;
export type MerchantId = string;

// ---------------------------------------------------------------------------
// Core objects
// ---------------------------------------------------------------------------

export type ActionCategory = "flight" | "hotel" | "transfer" | "saas" | "store" | "message";

export interface IntentConstraints {
  dates?: DateRange;
  budget_total?: Cents;
  destination?: string;
  categories?: ActionCategory[];
  must_haves?: string[];
}

/** The human's saved rules for fixes. Only the human sets these, never the buying agent after log_intent. */
export interface Preferences {
  no_store_credit: boolean;
  /** 0-100. A partial-refund counter at or above this percentage is accepted. */
  min_partial_refund_pct: number;
  /** Proxy may undo on its own at AUTO_UNDO_AT of the window. */
  auto_undo: boolean;
}

export interface Intent {
  task_id: TaskId;
  task_email: string;
  goal: string;
  constraints: IntentConstraints;
  preferences: Preferences;
  created_at: Timestamp;
}

export type ActionSource = "email" | "stripe" | "agent";

export type ActionState =
  | "found"
  | "planned"
  | "requested"
  | "accepted"
  | "countered"
  | "denied"
  | "no_agent"
  | "refund_pending"
  | "verified"
  | "failed"
  | "kept";

export interface Action {
  action_id: ActionId;
  task_id: TaskId;
  merchant: MerchantId;
  category: ActionCategory;
  summary: string;
  amount: Cents;
  dates?: DateRange;
  /** Merchant's booking or order reference. Actions are deduplicated by this. */
  ref: string;
  source: ActionSource;
  received_at: Timestamp;
  state: ActionState;
  /**
   * 0 to 1, set by capture: how sure extraction is. Omitted means certain (structured JSON-LD data,
   * Stripe events, the agent's own actions). Set it for LLM extraction.
   */
  confidence?: number;
}

/** Fields compare() checks: dates, amount over budget, wrong term, wrong item, duplicate. */
export type MismatchField = "dates" | "amount" | "term" | "item" | "duplicate";

export type MismatchValue = string | number | boolean | null;

/** Where a mismatch came from, so review and the dispute packet can cite the receipt. */
export interface MismatchEvidence {
  /** The action whose receipt (email or Stripe event) shows the wrong value. */
  source_action_id: ActionId;
  /** Field values as read from that receipt, e.g. { departure_date: "2026-11-03", reservationNumber: "AB12CD" }. */
  receipt_fields: Record<string, MismatchValue>;
}

export interface Mismatch {
  action_id: ActionId;
  field: MismatchField;
  expected: MismatchValue;
  actual: MismatchValue;
  /** Optional: compare() fills it when it can. */
  evidence?: MismatchEvidence;
}

export type ReversibilityKind = "cancel_refund" | "change" | "return" | "correct_message" | "none";

export interface Reversibility {
  kind: ReversibilityKind;
  /** null when there is no window (e.g. kind "none"). */
  window_ends_at: Timestamp | null;
  refundable: boolean;
  cost_to_reverse: Cents;
  /** Human-readable rule, e.g. "24-hour rule: full refund if booked at least 7 days out". */
  rule: string;
}

export type ChainState =
  | "detected"
  | "alerted"
  | "undoing"
  | "reversed"
  | "redo_requested"
  | "redone"
  | "closed"
  | "kept"
  | "partial"
  | "expired";

export type TaskState = "open" | "reviewed" | "clean" | "chain_open" | "closed";

export type AlertChannel = "sms" | "imessage" | "call";

export interface Alert {
  channel: AlertChannel;
  /** "chain_opened" is the one text per chain; "reminder" is escalation; "result" is the final text. */
  kind: "chain_opened" | "reminder" | "result" | "too_late";
  body: string;
  sent_at: Timestamp;
}

/** How one action is undone. */
export type RouteKind =
  /** Merchant has an agent: Reversal Protocol over Inkbox A2A (email carries the same JSON as fallback). */
  | "reversal_protocol"
  /** No agent: email support, follow up every FOLLOW_UP_EVERY, call if needed. */
  | "email_support"
  /** Rule-based cancel directly with the merchant simulator, e.g. the 24-hour flight rule. */
  | "self_serve"
  /** A message the agent sent: send a correction. */
  | "correction"
  /** Last resort: Stripe dispute with the evidence packet. */
  | "stripe_dispute";

/** The damage minimizer's choice for one action. */
export type FixOption = "cancel" | "change" | "keep";

export interface PlanStep {
  action_id: ActionId;
  route: RouteKind;
  option: FixOption;
  /** What this fix costs the human (fee or money lost). */
  cost: Cents;
  /** Latest time this step can still succeed. */
  deadline: Timestamp | null;
}

/** One row of the `steps` table: something the orchestrator did for one action. */
export interface Step {
  chain_id: ChainId;
  action_id: ActionId;
  route: RouteKind;
  protocol_state: ProtocolState | null;
  round: number;
  message: string;
  outcome: StepOutcome;
  /** Stripe refund or dispute id once one exists. */
  stripe_ref: string | null;
  at: Timestamp;
}

export type StepOutcome = "pending" | "succeeded" | "failed" | "skipped";

export interface Chain {
  chain_id: ChainId;
  task_id: TaskId;
  root_action_id: ActionId;
  action_ids: ActionId[];
  money_at_risk: Cents;
  /** Tightest window across the chain's actions. */
  window_ends_at: Timestamp | null;
  state: ChainState;
  alerts: Alert[];
  plan: PlanStep[];
  steps: Step[];
}

/** Handed back to the original agent after the chain is reversed. */
export interface RedoInstruction {
  task_id: TaskId;
  task_email: string;
  corrected_intent: Pick<Intent, "goal" | "constraints">;
  /** Plain instruction for the agent, e.g. "Rebook flight, hotel and transfer for Nov 13. Use the task email." */
  instruction: string;
  /** Categories to redo. */
  redo_categories: ActionCategory[];
}

/** A row of the `mistakes` resource and the `lessons` table. */
export interface Lesson {
  mistake_code: string;
  what_happened: string;
  lesson: string;
  created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Error contract and tool results
// ---------------------------------------------------------------------------

export type NextAction = "retry" | "fix_now" | "wait_for_human" | "redo" | "stop";

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  /** Same idempotency key with different arguments. */
  | "idempotency_conflict"
  /** The action is not one of the agent's own mismatched actions; only the human can decide. */
  | "requires_human"
  | "window_closed"
  | "upstream_unavailable"
  | "internal";

export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  next_action: NextAction;
}

export type ToolOk<T> = { ok: true } & T;

export type ToolResult<T> = ToolOk<T> | ToolError;

// ---------------------------------------------------------------------------
// MCP tools: input and output
// ---------------------------------------------------------------------------

export interface LogIntentInput {
  goal: string;
  constraints: IntentConstraints;
  /** Defaults apply when omitted (agreed at the freeze). */
  preferences?: Partial<Preferences>;
  idempotency_key: string;
}
export interface LogIntentOutput {
  task_id: TaskId;
  task_email: string;
}

export interface ReversibilityInput {
  merchant: MerchantId;
  category: ActionCategory;
  amount: Cents;
  dates?: DateRange;
}
export type ReversibilityOutput = Reversibility;

export interface ReviewInput {
  task_id: TaskId;
}
export interface EvidenceSeen {
  emails: number;
  stripe_events: number;
  actions: number;
}
export interface ReviewOutput {
  status: "clean" | "chain_open";
  mismatches: Mismatch[];
  /**
   * Actions the agent may undo itself with `undo`: its own flagged actions that are free to undo
   * with a full refund (self-serve route, no cost, no negotiation), and only while its session is active.
   * Everything else waits for the human's reply.
   */
  fixable_now: ActionId[];
  chain_ids: ChainId[];
  evidence_seen: EvidenceSeen;
}

export interface UndoInput {
  action_ids: ActionId[];
  reason: string;
}
export interface UndoOutput {
  accepted: ActionId[];
  /** Actions that fail the self-undo rule (see ReviewOutput.fixable_now); these go to the human. */
  requires_human: ActionId[];
  chain_id: ChainId | null;
}

export interface GetChainInput {
  chain_id: ChainId;
}
export interface ChainActionView {
  action_id: ActionId;
  merchant: MerchantId;
  category: ActionCategory;
  summary: string;
  amount: Cents;
  state: ActionState;
  route: RouteKind | null;
  /** True only when Stripe shows the refund. */
  stripe_verified: boolean;
}
export interface GetChainOutput {
  chain_id: ChainId;
  state: ChainState;
  actions: ChainActionView[];
  money_at_risk: Cents;
  window_ends_at: Timestamp | null;
  /** Reversal Protocol rounds used so far, across the chain. */
  rounds: number;
  redo?: RedoInstruction;
  next_action: NextAction;
}

export interface ListChainsInput {
  task_id?: TaskId;
}
export interface ChainSummary {
  chain_id: ChainId;
  task_id: TaskId;
  state: ChainState;
  money_at_risk: Cents;
  window_ends_at: Timestamp | null;
  action_count: number;
  root_summary: string;
}
export interface ListChainsOutput {
  /** Ranked by money_at_risk / max(hours_left, MIN_HOURS), highest first. */
  chains: ChainSummary[];
}

export type ToolName = "log_intent" | "reversibility" | "review" | "undo" | "get_chain" | "list_chains";

export interface ToolIO {
  log_intent: { input: LogIntentInput; output: LogIntentOutput };
  reversibility: { input: ReversibilityInput; output: ReversibilityOutput };
  review: { input: ReviewInput; output: ReviewOutput };
  undo: { input: UndoInput; output: UndoOutput };
  get_chain: { input: GetChainInput; output: GetChainOutput };
  list_chains: { input: ListChainsInput; output: ListChainsOutput };
}

export const MISTAKES_RESOURCE_URI = "proxy://mistakes";

/** Task ids map to Inkbox handles (task_demo -> task-demo@...), so only [a-z0-9_] is allowed. */
export const TASK_ID_PATTERN = /^[a-z0-9_]+$/;
export interface MistakesResource {
  lessons: Lesson[];
}

// ---------------------------------------------------------------------------
// Reversal Protocol (typed JSON over Inkbox A2A; email carries the same JSON)
// ---------------------------------------------------------------------------

export type ProtocolState =
  | "requested"
  | "accepted"
  | "countered"
  /** Proxy pushed back once; waiting for the merchant's answer. */
  | "pushed_back"
  | "denied"
  | "human_decision"
  | "refund_pending"
  | "verified"
  | "failed";

export interface EvidencePacket {
  intent: Intent;
  /** The order and its confirmation as captured. */
  order: Action;
  confirmation_excerpt: string;
  stripe_charge_id: string | null;
  mismatch: Mismatch;
  why_wrong: string;
  deadline: Timestamp;
}

/** Fields on every protocol message. */
export interface ProtocolEnvelope {
  negotiation_id: NegotiationId;
  chain_id: ChainId;
  action_id: ActionId;
  /** 1-based; at most 3. */
  round: number;
  sent_at: Timestamp;
}

export interface RequestReversal extends ProtocolEnvelope {
  type: "request_reversal";
  order: { merchant: MerchantId; ref: string; amount: Cents };
  intent: Pick<Intent, "goal" | "constraints">;
  what_went_wrong: string;
  deadline: Timestamp;
  evidence: EvidencePacket;
}

export interface AcceptMsg extends ProtocolEnvelope {
  type: "accept";
  refund_amount: Cents;
}

export type CounterKind = "partial_refund" | "store_credit" | "exchange";

export interface CounterMsg extends ProtocolEnvelope {
  type: "counter";
  kind: CounterKind;
  amount: Cents;
}

export interface DenyMsg extends ProtocolEnvelope {
  type: "deny";
  reason: string;
}

export interface AcceptCounterMsg extends ProtocolEnvelope {
  type: "accept_counter";
}

export interface PushBackMsg extends ProtocolEnvelope {
  type: "push_back";
  reason: string;
}

export interface AskHumanMsg extends ProtocolEnvelope {
  type: "ask_human";
  /** The counter the human is asked about. */
  counter: { kind: CounterKind; amount: Cents };
}

export type ProxyProtocolMessage = RequestReversal | AcceptCounterMsg | PushBackMsg | AskHumanMsg;
export type MerchantProtocolMessage = AcceptMsg | CounterMsg | DenyMsg;
export type ReversalMessage = ProxyProtocolMessage | MerchantProtocolMessage;

/** State negotiate_step works on. */
export interface NegotiationState {
  negotiation_id: NegotiationId;
  chain_id: ChainId;
  action_id: ActionId;
  state: ProtocolState;
  round: number;
  push_backs_used: number;
  /** Earlier of the action's window and PROTOCOL_DEADLINE. */
  deadline: Timestamp;
  order_amount: Cents;
  last_counter: { kind: CounterKind; amount: Cents } | null;
}

export interface NegotiateStepResult {
  next_state: NegotiationState;
  outgoing?: ProxyProtocolMessage;
}

// ---------------------------------------------------------------------------
// Humans, Stripe events, the events log
// ---------------------------------------------------------------------------

/** A reply from the human's phone, parsed by src/inkbox/. Only the human's number produces one. */
export type HumanReply =
  | { kind: "undo_all"; chain_id: ChainId; received_at: Timestamp }
  /** 1-based numbers from the PICK list. */
  | { kind: "pick"; chain_id: ChainId; picks: number[]; received_at: Timestamp }
  | { kind: "keep"; chain_id: ChainId; received_at: Timestamp }
  /** Answer to ask_human during a negotiation. */
  | { kind: "counter_decision"; chain_id: ChainId; negotiation_id: NegotiationId; accept: boolean; received_at: Timestamp }
  /** STOP: freezes all undo activity for this human, across every chain, until they reply again. */
  | { kind: "stop"; received_at: Timestamp }
  /**
   * A free-text correction such as "ugh no the 13th". The orchestrator confirms it once with the
   * human before acting on it.
   */
  | { kind: "correction"; chain_id: ChainId; corrected_text: string; received_at: Timestamp };

export type StripeEventKind = "charge.succeeded" | "charge.refunded" | "refund.updated" | "charge.dispute.created";

export interface StripeEventRecord {
  stripe_event_id: string;
  kind: StripeEventKind;
  task_id: TaskId | null;
  charge_id: string;
  amount: Cents;
  refunded_amount: Cents;
  merchant: MerchantId | null;
  at: Timestamp;
}

export type Arm = "naive" | "proxy";
export type EvalLayer = "scripted" | "live";
export type EventKind =
  | "tool"
  | "email_in"
  | "email_out"
  | "stripe_event"
  | "sms_out"
  | "sms_in"
  | "imessage_out"
  | "imessage_in"
  | "a2a"
  | "call"
  | "call_out";

/** One row of the append-only `events` table. No updates or deletes. */
export interface EventRow {
  run_id: string;
  arm: Arm;
  /** Demo runs use a fixed agreed value. */
  scenario_id: string;
  layer: EvalLayer;
  kind: EventKind;
  tool_name: ToolName | null;
  task_id: TaskId | null;
  chain_id: ChainId | null;
  action_id: ActionId | null;
  outcome: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  timestamp: Timestamp;
}

// ---------------------------------------------------------------------------
// Parameters agreed at the freeze
// ---------------------------------------------------------------------------

export interface Params {
  /** Floor on hours_left in rank(). */
  MIN_HOURS: number;
  /** Wait before escalating SMS to iMessage, in ms. */
  REPLY_WAIT: number;
  /** Fraction of the window (0-1) at which Proxy calls. */
  CALL_AT: number;
  /** Fraction of the window (0-1) at which auto-undo acts, if opted in. */
  AUTO_UNDO_AT: number;
  /** Support-email follow-up interval, in ms. */
  FOLLOW_UP_EVERY: number;
  /** Max protocol duration, in ms. */
  PROTOCOL_DEADLINE: number;
  /** Simulated ms per real ms. */
  CLOCK_SCALE: number;
  /** The agent's session ends after this many ms without a tool call for the task, in ms. */
  SESSION_IDLE_MS: number;
  DEFAULT_PREFERENCES: Preferences;
}

// ---------------------------------------------------------------------------
// Interfaces other folders implement
// ---------------------------------------------------------------------------

/** src/orchestrator/ (Karan). Everything reads time from here so evals run on the simulated clock. */
export interface Clock {
  now(): Timestamp;
  nowMs(): number;
  readonly mode: "real" | "simulated";
}

export interface SimulatedClock extends Clock {
  readonly mode: "simulated";
  set(t: Timestamp): void;
  advance(ms: number): void;
}

/** src/orchestrator/ (Karan). Tracks whether the buying agent is still working on a task. */
export interface Sessions {
  /** Called on every tool call that names the task. */
  touch(task_id: TaskId): void;
  /** Ends the session now, e.g. when the scripted demo agent leaves. */
  end(task_id: TaskId): void;
  /** Active until end() or SESSION_IDLE_MS without a touch. */
  isActive(task_id: TaskId): boolean;
}

/** src/logic/ (Dhwanil). Pure functions; anything time-dependent takes `now`. */
export interface Logic {
  compare(intent: Intent, actions: Action[]): Mismatch[];
  /**
   * Groups a root mistake with the actions that depend on it. The root is the earliest booked
   * action with a mismatch: among actions whose category is not "message", the earliest received_at.
   * A message is the root only when the chain has no booked action.
   */
  trace(intent: Intent, actions: Action[], mismatches: Mismatch[]): Chain[];
  reversibility(action: Action, now: Timestamp): Reversibility;
  /**
   * Damage minimizer and route selection: cheapest fix per action within the window and preferences,
   * most urgent first. `actions` are the chain's actions (chain.action_ids resolved).
   */
  plan_undo(chain: Chain, actions: Action[], preferences: Preferences, now: Timestamp): PlanStep[];
  /** Sorts by money_at_risk / max(hours_left, MIN_HOURS). */
  rank(chains: Chain[], now: Timestamp): Chain[];
  negotiate_step(state: NegotiationState, message: MerchantProtocolMessage, preferences: Preferences): NegotiateStepResult;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  /** JSON attachments, e.g. the evidence packet. */
  attachments?: { filename: string; json: unknown }[];
  /** Thread for follow-ups. */
  thread_id?: string;
}

/** src/inkbox/ (Sarah). Proxy's identity: email, SMS, iMessage, phone, A2A. */
export interface Inkbox {
  /** Unique address per task (or a plus-address fallback). */
  createTaskAddress(task_id: TaskId): Promise<{ task_email: string }>;
  sendText(channel: "sms" | "imessage", to: string, body: string): Promise<{ message_id: string }>;
  placeCall(to: string, script: string): Promise<{ call_id: string }>;
  sendEmail(email: OutboundEmail): Promise<{ message_id: string; thread_id: string }>;
  /** Over A2A; falls back to email with the same JSON when A2A is unavailable. */
  sendProtocolMessage(to_identity: string, message: ProxyProtocolMessage): Promise<{ via: "a2a" | "email" }>;
}

/** src/db/ (Sarah). Supabase-backed storage the tools and orchestrator read and write. */
export interface Store {
  putIntent(intent: Intent, idempotency_key: string): Promise<Intent>;
  getIntent(task_id: TaskId): Promise<Intent | null>;
  getIntentByIdempotencyKey(key: string): Promise<Intent | null>;
  listActions(task_id: TaskId): Promise<Action[]>;
  getAction(action_id: ActionId): Promise<Action | null>;
  upsertAction(action: Action): Promise<Action>;
  getChain(chain_id: ChainId): Promise<Chain | null>;
  listChains(task_id?: TaskId): Promise<Chain[]>;
  upsertChain(chain: Chain): Promise<Chain>;
  appendStep(step: Step): Promise<void>;
  listLessons(): Promise<Lesson[]>;
  addLesson(lesson: Lesson): Promise<void>;
  countEvidence(task_id: TaskId): Promise<EvidenceSeen>;
  /** Append-only. */
  logEvent(row: EventRow): Promise<void>;
}

/** src/stripe/ (Karan's second agent). Stripe test mode is the source of truth for money. */
export interface Payments {
  refund(charge_id: string, amount: Cents, idempotency_key: string): Promise<{ refund_id: string }>;
  /** True only when Stripe shows the refund succeeded for at least `amount`. */
  verifyRefund(charge_id: string, amount: Cents): Promise<{ verified: boolean; refunded_amount: Cents }>;
  createDispute(charge_id: string, evidence: EvidencePacket): Promise<{ dispute_id: string }>;
  findChargeForAction(action: Action): Promise<string | null>;
}

// --- Mock merchants (src/merchants/, Dhwanil) ---

export interface MerchantInfo {
  merchant_id: MerchantId;
  name: string;
  category: ActionCategory;
  has_agent: boolean;
  /** Inkbox identity of the merchant agent, when has_agent. */
  agent_identity?: string;
  support_email?: string;
}

export interface BookingRequest {
  merchant_id: MerchantId;
  task_id: TaskId;
  /** Confirmation goes here. */
  task_email: string;
  item: string;
  dates?: DateRange;
  amount: Cents;
  /** Seeded booking time on the simulated clock. */
  booked_at: Timestamp;
}

export interface BookingResult {
  ref: string;
  amount: Cents;
  stripe_charge_id: string;
}

/** schema.org JSON-LD in the confirmation email (FlightReservation, LodgingReservation, Order, ...). */
export interface JsonLdConfirmation {
  "@context": "https://schema.org";
  "@type": "FlightReservation" | "LodgingReservation" | "TaxiReservation" | "Order" | "Invoice";
  reservationNumber?: string;
  orderNumber?: string;
  [key: string]: unknown;
}

export interface SelfServeCancelResult {
  ok: boolean;
  refund_amount: Cents;
  stripe_refund_id: string | null;
  reason?: string;
}

/** The merchant agent hook: answers one Proxy protocol message. Stubbed in evals. */
export interface MerchantAgent {
  merchant_id: MerchantId;
  respond(message: ProxyProtocolMessage, now: Timestamp): Promise<MerchantProtocolMessage>;
}

export interface Merchants {
  list(): MerchantInfo[];
  get(merchant_id: MerchantId): MerchantInfo | null;
  book(request: BookingRequest): Promise<BookingResult>;
  /** Rule-based cancel through the merchant simulator (e.g. the 24-hour flight rule). */
  selfServeCancel(merchant_id: MerchantId, ref: string, now: Timestamp): Promise<SelfServeCancelResult>;
  agent(merchant_id: MerchantId): MerchantAgent | null;
}

// --- Hooks the orchestrator exposes for capture, inkbox and stripe to call ---

export interface OrchestratorHooks {
  /** src/capture/ calls this for each new, deduplicated Action. */
  onAction(action: Action): Promise<void>;
  onStripeEvent(event: StripeEventRecord): Promise<void>;
  onHumanReply(reply: HumanReply): Promise<void>;
  onProtocolMessage(message: MerchantProtocolMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP routes other folders mount on the server (webhooks, merchant endpoints, demo page)
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteRequest {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Raw body, needed for Stripe and Inkbox webhook signature checks. */
  rawBody: string;
}

export interface RouteResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | object;
}

export interface RouteHandler {
  method: HttpMethod;
  /** Must start with the owning folder's prefix, e.g. "/webhooks/stripe", "/inkbox/inbound", "/merchants/airline/book". */
  path: string;
  handle(req: RouteRequest): Promise<RouteResponse>;
}
