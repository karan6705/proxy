// Runs a chain's undo after the human says UNDO ALL (or PICK): the plan from Dhwanil's plan_undo, then each
// action by its route, cheapest and most urgent first.
//   self_serve          merchant rule-based cancel, then refund and verify (routes/self-serve.ts)
//   reversal_protocol   request, counter, push back, counter, accept_counter, accept: negotiate_step decides
//                       every reply, the merchant agent answers over Inkbox A2A (email fallback)
//   email_support       email to the merchant's support desk; on approval, refund and verify
//   correction          email to the person who got the wrong message; moves no money
// Money counts only after refundOnce says Stripe shows the agreed amount.
import type {
  Action,
  CounterKind,
  Cents,
  Chain,
  ChainId,
  Clock,
  Inkbox,
  Intent,
  Logic,
  Merchants,
  MerchantProtocolMessage,
  MerchantId,
  NegotiationState,
  Params,
  Payments,
  PlanStep,
  ProxyProtocolMessage,
  RequestReversal,
  Step,
  StepOutcome,
  Store,
} from "../types.js";
import { expectedRefund, refundOnce } from "./refunds.js";
import { humanDate, type AlreadyUndone } from "./copy.js";
import { runSelfServeRoute } from "./routes/self-serve.js";
import { chainSummary, correctionStep, deniedStep, merchantLine, merchantSaid, nextOption, noAnswerYet, howUndone, offerOptionsText, optionLabel, proxyLine, proxyWhy, pushBackKind, refundedStep, stillWorking, type ProxyLineContext } from "./copy.js";
import { MAX_ROUNDS } from "../logic/negotiate-step.js";
import type { FeedActor, FeedEntry } from "./feed.js";
import type { CarrierScan, ReturnsPortal } from "../merchants/deps.js";
import { createReturnFlow } from "./return-flow.js";

/** What a support desk answers: whether it approved and the refund it agreed. */
export interface SupportAnswer {
  approved: boolean;
  refund_amount: Cents;
}

export interface UndoMerchants extends Pick<Merchants, "selfServeCancel" | "get" | "agent"> {
  hasSupportDesk(merchant_id: MerchantId): boolean;
  supportEmail(merchant_id: MerchantId, email: { from: string; subject: string; body: string }, now: string): Promise<SupportAnswer>;
  /** The merchant's web return form, for a merchant whose agent sends refunds there (return-flow.ts). */
  returnPortal?(merchant_id: MerchantId): ReturnsPortal | null;
}

/** How Proxy's messages reach a merchant agent. Real mode: Inkbox. Loopback: the in-process mock agent answers. */
export interface ProtocolTransport {
  /** `via: "email"` is the follow-up path when the agent hasn't answered: the same JSON by email. */
  send(merchant: MerchantId, to_identity: string, message: ProxyProtocolMessage, via?: "default" | "email"): Promise<void>;
}

export interface UndoDeps {
  store: Store;
  logic: Logic;
  inkbox: Inkbox;
  payments: Payments;
  merchants: UndoMerchants;
  clock: Clock;
  params: Params;
  transport: ProtocolTransport;
  /** Address support emails are sent from. */
  proxyEmail: string;
  isFrozen(): boolean;
  /** What refunds are confirmed in, for texts and the feed ("Stripe (simulated)" in the sandbox). */
  paymentsName?: string;
  /** Adds a line to the demo feed. */
  note?(entry: Omit<FeedEntry, "seq" | "at"> & { at?: string }): void;
  /** Called once a chain is reversed and the redo is handed back. */
  onReversed?(chain_id: ChainId): Promise<void>;
  /** Runs fn alone for this chain, so concurrent steps don't overwrite each other's chain updates. */
  lockChain<T>(chain_id: ChainId, fn: () => Promise<T>): Promise<T>;
  textHuman(chain_id: ChainId, kind: "chain_opened" | "reminder" | "progress" | "result" | "too_late", body: string): Promise<void>;
  askHumanAboutCounter(chain_id: ChainId, negotiation_id: string, body: string): Promise<void>;
  logEvent(row: { kind: "a2a" | "email_out"; chain_id?: ChainId | null; action_id?: string | null; outcome?: string | null; task_id?: string | null }): Promise<void>;
}

export interface UndoExecutor {
  /** Starts the undo for a chain, or only for the actions numbered in `picks` (1-based, in chain order). */
  start(chain_id: ChainId, picks?: number[]): Promise<void>;
  /** The human answered a counteroffer question. */
  /** The human's answer to Proxy's options: a number, KEEP PUSHING, or YES / NO (`accept`). */
  decideCounter(chain_id: ChainId, negotiation_id: string, decision: boolean | { accept: boolean; choice?: number; push?: boolean }): Promise<void>;
  /** A merchant agent's answer arrived (A2A, email or loopback). */
  onProtocolMessage(message: MerchantProtocolMessage, realReceivedAt?: string): Promise<void>;
  /** Marks the chain's actions kept and closes it. */
  keep(chain_id: ChainId): Promise<void>;
  /** After STOP is lifted: carries on with steps the STOP held back, on every chain still undoing. */
  resume(): Promise<void>;
  /** The (simulated) carrier scanned a package returned through a merchant's return form. */
  onCarrierScan(scan: CarrierScan): Promise<void>;
  /** Latest real-time ISO of a processed merchant message, for restarting the inbox. Null when none. */
  lastProcessedAt(): Promise<string | null>;
}

const DATE_OF = (intent: Intent) => intent.constraints.dates;
const money = (c: Cents) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const DONE_STATES = new Set<Action["state"]>(["verified", "accepted", "kept", "failed", "denied", "no_agent"]);
/** Negotiation states in which Proxy is waiting on the merchant agent. */
/** One merchant offer, typed fields only. */
type Offer = { kind: CounterKind; amount: Cents };

/** Proxy's side of one negotiation. */
interface Negotiation {
  state: NegotiationState;
  merchant: MerchantId;
  chain_id: ChainId;
  action: Action;
  /** When the booking's own window closes (the plan's deadline), for the "time left" in Proxy's reasons. */
  window?: string | null;
  /** Every distinct offer the merchant made; the human chooses among them. */
  offers: Offer[];
  /** The open question to the human, while the negotiation is paused. */
  asked?: { options: Offer[]; recommended: number | null; canPush: boolean; text: string };
  /** The option the human chose. */
  chosen?: Offer;
  /** The next push back is the human's KEEP PUSHING. */
  pushByHuman?: boolean;
  remind?: ReturnType<typeof setTimeout>;
}

const WAITING = new Set<NegotiationState["state"]>(["requested", "countered", "pushed_back", "accepted"]);
const IN_MARK = /\[in:([^|\]]+)\|[^\]]*\]$/;

/** Actions in the chain the agent refunded itself during its session (its own self-serve undo). */
export function undoneByAgent(chain: Pick<Chain, "action_ids" | "steps">, actions: Action[]): AlreadyUndone[] {
  return actions
    .filter((a) => chain.action_ids.includes(a.action_id) && a.state === "verified")
    .filter((a) => chain.steps.some((s) => s.action_id === a.action_id && s.message.startsWith("Self-undo requested by the agent")))
    .map((a) => ({ action: a, amount: a.amount }));
}

/** Who speaks for a merchant in the feed. */
export function actorFor(merchant: MerchantId): FeedActor {
  return merchant === "hotel" ? "hotel_agent" : merchant === "transfer" ? "transfer_support" : merchant === "host" ? "host" : merchant === "airline" ? "airline" : merchant === "northwind" ? "store" : "proxy";
}

export function createUndoExecutor(deps: UndoDeps): UndoExecutor {
  const { store, logic, clock, payments, merchants } = deps;
  const paymentsName = deps.paymentsName ?? "Stripe";
  const note = (chain: Pick<Chain, "task_id" | "chain_id">, actor: FeedActor, kind: FeedEntry["kind"], text: string, data: FeedEntry["data"] = {}) =>
    deps.note?.({ task_id: chain.task_id, chain_id: chain.chain_id, actor, kind, text, data });
  const nameOf = (merchant: string) => merchants.get(merchant)?.name ?? merchant;
  const stripeNote = (chain: Chain, action: Action, refunded: Cents, ref: string | null, how?: string) =>
    note(chain, "stripe", "stripe_refund", `${paymentsName}: ${money(refunded)} refunded on the ${nameOf(action.merchant)} charge, confirmed.`, {
      action_id: action.action_id,
      merchant: action.merchant,
      amount: refunded,
      of: action.amount,
      refund_id: ref,
      how: how ?? null,
    });
  /** `window` is when the booking's own window closes (the plan's deadline), for the "time left" in Proxy's reasons. */
  const negotiations = new Map<string, Negotiation>();
  const queues = new Map<string, Promise<void>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(key, run.then(() => undefined, () => undefined));
    return run;
  };

  async function step(chain: Chain, action: Action, route: Step["route"], outcome: StepOutcome, message: string, extra: Partial<Step> = {}) {
    await store.appendStep({
      chain_id: chain.chain_id,
      action_id: action.action_id,
      route,
      protocol_state: null,
      round: 0,
      message,
      outcome,
      stripe_ref: null,
      at: clock.now(),
      ...extra,
    });
  }

  async function setState(action: Action, state: Action["state"]): Promise<Action> {
    return store.upsertAction({ ...action, state });
  }

  async function load(chain_id: ChainId) {
    const chain = await store.getChain(chain_id);
    if (!chain) throw new Error(`No chain ${chain_id}`);
    const intent = await store.getIntent(chain.task_id);
    if (!intent) throw new Error(`No intent for ${chain.task_id}`);
    const actions: Action[] = [];
    for (const id of chain.action_ids) {
      const a = await store.getAction(id);
      if (a) actions.push(a);
    }
    return { chain, intent, actions };
  }

  async function savePlanRefund(chain_id: ChainId, action_id: string, refund_amount: Cents) {
    await deps.lockChain(chain_id, async () => {
      const chain = await store.getChain(chain_id);
      if (!chain) return;
      const plan = chain.plan.some((p) => p.action_id === action_id)
        ? chain.plan.map((p) => (p.action_id === action_id ? { ...p, refund_amount } : p))
        : [...chain.plan, { action_id, route: "reversal_protocol" as const, option: "cancel" as const, cost: 0, deadline: null, refund_amount }];
      await store.upsertChain({ ...chain, plan });
    });
  }

  /**
   * Demo pacing: a visible "waiting" line, then a pause of `factor` x DEMO_PACE_MS, so a viewer can follow each step.
   * DEMO_PACE_MS is 0 outside demo mode (and in tests), so this does nothing there.
   */
  async function pace(chain: Pick<Chain, "task_id" | "chain_id">, factor: number, waiting?: { text: string; merchant: string; action_id: string }) {
    const ms = (deps.params.DEMO_PACE_MS ?? 0) * factor;
    if (ms <= 0) return;
    if (waiting) note(chain, "proxy", "wait", waiting.text, { merchant: waiting.merchant, action_id: waiting.action_id, ms });
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Refunds the agreed amount once and records whether Stripe shows it. Returns the action's new state. */
  async function refundAndVerify(chain: Chain, action: Action, agreed: Cents, route: Step["route"], note: string, howDone?: string): Promise<Action["state"]> {
    await savePlanRefund(chain.chain_id, action.action_id, agreed);
    await pace(chain, 0.6, { text: `Refund of ${money(agreed)} issued; verifying it in ${paymentsName}…`, merchant: action.merchant, action_id: action.action_id });
    const r = await refundOnce(payments, action, agreed);
    if (r.status === "no_charge") {
      await setState(action, "failed");
      await step(chain, action, route, "failed", `${note}; no Stripe charge found for this action`);
      return "failed";
    }
    const ref = r.refund_id ?? r.charge_id;
    if (!r.verified) {
      await setState(action, "refund_pending");
      await step(chain, action, route, "pending", `${note}; Stripe shows ${money(r.refunded_amount)} of ${money(agreed)} so far`, { stripe_ref: ref });
      return "refund_pending";
    }
    await setState(action, "verified");
    await step(chain, action, route, "succeeded", `${note}; refunded ${money(agreed)}, verified in Stripe`, { stripe_ref: ref });
    const how = howDone ?? howUndone(action, route, nameOf(action.merchant));
    stripeNote(chain, action, r.refunded_amount, ref, how);
    await deps.textHuman(chain.chain_id, "progress", refundedStep(action, r.refunded_amount, paymentsName, how));
    return "verified";
  }

  async function finishIfDone(chain_id: ChainId) {
    // Decide and record the outcome under the lock, so two steps finishing together send one summary.
    const outcome = await deps.lockChain(chain_id, async () => {
      const { chain, intent, actions } = await load(chain_id);
      if (chain.state !== "undoing") return null;
      const todo = actions.filter((a) => chain.plan.some((p) => p.action_id === a.action_id && p.option !== "keep"));
      // "accepted" is done only for a correction (no money); for a refund it means the counter is agreed but
      // the money hasn't moved yet.
      const done = (a: Action) => DONE_STATES.has(a.state) && !(a.state === "accepted" && a.amount > 0);
      if (todo.some((a) => !done(a))) return null;
      const bad = todo.filter((a) => a.state === "failed" || a.state === "denied" || a.state === "no_agent");
      // Actions the human didn't pick (PICK) stay as they are; already-settled ones (e.g. the agent's own undo) count.
      const planned = new Set(chain.plan.map((p) => p.action_id));
      const untouched = actions.filter((a) => !planned.has(a.action_id) && !["verified", "kept", "accepted"].includes(a.state));
      // A step the plan kept is not done: it stays open, with whatever fix is still possible (e.g. a paid change).
      const keptByPlan = new Set(chain.plan.filter((p) => p.option === "keep" || p.route === "keep").map((p) => p.action_id));
      const optionFor = (a: Action) => {
        const step = chain.plan.find((p) => p.action_id === a.action_id);
        if (!keptByPlan.has(a.action_id)) return nextOption(a, step);
        const rev = logic.reversibility(a, clock.now());
        return nextOption(a, rev.kind === "change" && rev.cost_to_reverse > 0 ? { option: "change", cost: rev.cost_to_reverse } : undefined);
      };
      const summary = chainSummary(
        actions.filter((a) => !untouched.includes(a)).map((a) => ({
          action: a,
          refunded: a.state === "verified" ? expectedRefund(chain, a) : 0,
          credit: chain.plan.find((p) => p.action_id === a.action_id)?.credit_amount ?? 0,
          next: optionFor(a),
          still_open: keptByPlan.has(a.action_id) && a.state === "kept",
        })),
        DATE_OF(intent),
        untouched,
        undoneByAgent(chain, actions),
        paymentsName,
      );
      // Partial: some items need the human or weren't picked. Otherwise the agent gets the corrected intent (redo).
      const reversed = !bad.length && !untouched.length && !actions.some((a) => keptByPlan.has(a.action_id) && a.state === "kept");
      await store.upsertChain({ ...chain, state: reversed ? "redo_requested" : "partial" });
      return { summary, reversed };
    });
    if (!outcome) return;
    await deps.textHuman(chain_id, "result", outcome.summary);
    if (outcome.reversed) await deps.onReversed?.(chain_id);
  }

  const returnFlow = createReturnFlow({
    clock,
    portal: (merchant) => merchants.returnPortal?.(merchant) ?? null,
    merchantName: (merchant) => merchants.get(merchant)?.name ?? merchant,
    note: (chain, actor, kind, text, data = {}) => note(chain, actor, kind, text, data),
    step: (chain, action, route, outcome, message) => step(chain, action, route, outcome, message),
    setState,
    getAction: (action_id) => store.getAction(action_id),
    getChain: (chain_id) => store.getChain(chain_id),
    textHuman: (chain_id, kind, body) => deps.textHuman(chain_id, kind, body),
    refundAndVerify,
    finishIfDone,
    isFrozen: () => deps.isFrozen(),
    pace: (chain, factor) => pace(chain, factor),
  });

  // --- routes ---

  async function runSelfServe(chain: Chain, action: Action) {
    await pace(chain, 0.6, { text: `Cancelling on ${nameOf(action.merchant)}'s site and verifying the refund in ${paymentsName}…`, merchant: action.merchant, action_id: action.action_id });
    const r = await runSelfServeRoute({ merchants, payments, store, clock }, chain, action);
    if (r.action.state === "verified") {
      const how = howUndone(action, "self_serve", nameOf(action.merchant));
      stripeNote(chain, action, action.amount, r.step.stripe_ref, how);
      await deps.textHuman(chain.chain_id, "progress", refundedStep(action, action.amount, paymentsName, how));
    }
  }

  function requestFor(chain: Chain, intent: Intent, action: Action, state: NegotiationState): RequestReversal {
    const sent_at = clock.now();
    // A wrong item (not wrong dates) is described by its own mismatch.
    const item = logic.compare(intent, [action]).find((m) => m.action_id === action.action_id && m.field === "item");
    return {
      type: "request_reversal",
      negotiation_id: state.negotiation_id,
      chain_id: chain.chain_id,
      action_id: action.action_id,
      round: 1,
      sent_at,
      order: { merchant: action.merchant, ref: action.ref, amount: action.amount },
      intent: { goal: intent.goal, constraints: intent.constraints },
      what_went_wrong: item ? `ordered ${String(item.actual)}; the task asked for ${String(item.expected)}` : `booked for ${action.dates?.start ? humanDate(action.dates.start) : "the wrong dates"}; the trip is ${intent.constraints.dates ? `${humanDate(intent.constraints.dates.start)}${intent.constraints.dates.end ? ` to ${humanDate(intent.constraints.dates.end)}` : ""}` : "on other dates"}`,
      deadline: state.deadline,
      evidence: {
        intent,
        order: action,
        confirmation_excerpt: action.summary,
        stripe_charge_id: null,
        mismatch: item ?? { action_id: action.action_id, field: "dates", expected: intent.constraints.dates?.start ?? "", actual: action.dates?.start ?? "" },
        why_wrong: item ? "The order is not the item the task asked for." : "The booking does not match the task's dates.",
        deadline: state.deadline,
        message_timeline: [{ at: sent_at, channel: "a2a", direction: "outbound", summary: "Reversal requested" }],
      },
    };
  }

  async function runProtocol(chain: Chain, intent: Intent, action: Action, plan: PlanStep) {
    const info = merchants.get(action.merchant);
    const agent = info?.agent_identity;
    if (!info || !info.has_agent || !agent) {
      await setState(action, "no_agent");
      await step(chain, action, "reversal_protocol", "failed", `${action.merchant} has no agent to negotiate with`);
      return;
    }
    const now = clock.nowMs();
    const hardStop = now + deps.params.PROTOCOL_DEADLINE;
    const window = plan.deadline ? Date.parse(plan.deadline) : Number.POSITIVE_INFINITY;
    const state: NegotiationState = {
      negotiation_id: `neg_${action.action_id}`,
      chain_id: chain.chain_id,
      action_id: action.action_id,
      state: "requested",
      round: 1,
      push_backs_used: 0,
      deadline: new Date(Math.min(hardStop, window)).toISOString(),
      order_amount: action.amount,
      last_counter: null,
    };
    const request = requestFor(chain, intent, action, state);
    const updated = await setState(action, "requested");
    negotiations.set(state.negotiation_id, { state, merchant: action.merchant, chain_id: chain.chain_id, action: updated, window: plan.deadline ?? null, offers: [] });
    await step(chain, action, "reversal_protocol", "pending", "Asked the merchant agent to reverse the booking", { protocol_state: "requested", round: 1 });
    await deps.logEvent({ kind: "a2a", chain_id: chain.chain_id, action_id: action.action_id, outcome: "out:request_reversal" });
    await sendToAgent(state.negotiation_id, request);
  }

  // --- waiting on the merchant agent: follow up by email, then give up, never silently ---

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSent = new Map<string, ProxyProtocolMessage>();
  const followedUp = new Set<string>();

  async function sendToAgent(negotiation_id: string, message: ProxyProtocolMessage, via: "default" | "email" = "default") {
    const neg = negotiations.get(negotiation_id);
    if (!neg) return;
    // Demo pacing: about 2 s between the merchant's message and Proxy's answer, so each can be read on screen.
    if (message.type !== "request_reversal") await pace({ task_id: neg.action.task_id, chain_id: neg.chain_id }, 0.8);
    armTimer(negotiation_id);
    const intent = await store.getIntent(neg.action.task_id);
    const d = intent?.constraints.dates;
    const ctx: ProxyLineContext = {
      summary: `this ${neg.action.category}`,
      amount: neg.action.amount,
      lastCounter: neg.state.last_counter,
      minPct: intent?.preferences.min_partial_refund_pct ?? 0,
      mismatch: message.type === "request_reversal" ? message.evidence.mismatch : undefined,
      ref: neg.action.ref,
      noStoreCredit: intent?.preferences.no_store_credit ?? false,
      timeLeftMs: neg.window ? Date.parse(neg.window) - clock.nowMs() : null,
      byHuman: message.type === "push_back" && neg.pushByHuman === true,
      ...(d ? { rebook: `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` } : {}),
    };
    const line = proxyLine(message, ctx);
    const why = proxyWhy(message, ctx);
    neg.pushByHuman = false;
    // Every message carries its line and its reason next to the typed fields; the merchant acts only on the typed ones.
    const carried = { ...message, message: line.replace(/^Proxy:\s*/, ""), why } as unknown as ProxyProtocolMessage;
    lastSent.set(negotiation_id, carried);
    const offer = neg.state.last_counter;
    note(
      { task_id: neg.action.task_id, chain_id: neg.chain_id },
      "proxy",
      "protocol_out",
      `${line}${via === "email" ? " (sent again by email)" : ""}`,
      {
        type: message.type,
        round: message.round,
        negotiation_id,
        via,
        to: merchants.get(neg.merchant)?.agent_identity ?? neg.merchant,
        merchant: neg.merchant,
        action_id: neg.action.action_id,
        // What Proxy checked before deciding, for the page's "Proxy is checking" card. Typed values only.
        why,
        decision: message.type === "push_back" ? pushBackKind(ctx) : message.type,
        order_amount: neg.action.amount,
        offer_kind: offer?.kind ?? null,
        offer_amount: offer?.amount ?? null,
        min_pct: ctx.minPct,
        no_store_credit: ctx.noStoreCredit ?? false,
        time_left_ms: ctx.timeLeftMs ?? null,
      },
    );
    // Never awaited: a merchant agent that is slow or hangs must not hold up the other steps. The timer
    // above follows up if no answer comes.
    deps.transport
      .send(neg.merchant, merchants.get(neg.merchant)?.agent_identity ?? neg.merchant, carried, via)
      .catch((e) => console.error(`[undo] sending ${message.type} to ${neg.merchant} failed:`, e instanceof Error ? e.name : e));
  }

  function armTimer(negotiation_id: string) {
    clearTimeout(timers.get(negotiation_id));
    const t = setTimeout(() => {
      timers.delete(negotiation_id);
      serial(negotiation_id, () => onSilence(negotiation_id)).catch((e) => console.error("[undo] follow-up failed:", e));
    }, deps.params.MERCHANT_REPLY_TIMEOUT);
    t.unref?.();
    timers.set(negotiation_id, t);
  }

  async function onSilence(negotiation_id: string) {
    const neg = negotiations.get(negotiation_id);
    if (!neg || !WAITING.has(neg.state.state)) return;
    const chain = await store.getChain(neg.chain_id);
    if (!chain || chain.state !== "undoing") return; // closed, kept or expired meanwhile
    const action = (await store.getAction(neg.action.action_id)) ?? neg.action;
    const last = lastSent.get(negotiation_id);
    if (!followedUp.has(negotiation_id) && last) {
      followedUp.add(negotiation_id);
      await step(chain, action, "reversal_protocol", "pending", "No answer from the merchant agent; following up by email", { protocol_state: neg.state.state, round: neg.state.round });
      await deps.textHuman(chain.chain_id, "progress", noAnswerYet(action));
      await deps.logEvent({ kind: "email_out", chain_id: chain.chain_id, action_id: action.action_id, outcome: `follow_up:${last.type}` });
      await sendToAgent(negotiation_id, { ...last, sent_at: clock.now() } as ProxyProtocolMessage, "email");
      return;
    }
    neg.state = { ...neg.state, state: "failed" };
    await setState(action, "failed");
    await step(chain, action, "reversal_protocol", "failed", "The merchant never answered, by agent or by email", { protocol_state: "failed" });
    // The summary that follows names the next option.
    await deps.textHuman(chain.chain_id, "reminder", `The ${action.merchant} never answered, by its agent or by email.`);
    await finishIfDone(chain.chain_id);
  }

  /**
   * The last line of defence: no chain sits silently. The protocol's own timers normally settle every step first;
   * if a chain is still undoing after 3 merchant timeouts anyway, the human gets a text saying what Proxy is still
   * waiting on, and after 5 every open step that isn't waiting on the human is marked failed, so the chain finishes
   * and its summary names the next option.
   */
  function armWatchdog(chain_id: ChainId) {
    const unit = deps.params.MERCHANT_REPLY_TIMEOUT;
    const check = async (final: boolean) => {
      const chain = await store.getChain(chain_id);
      if (!chain || chain.state !== "undoing" || deps.isFrozen()) return;
      const { actions } = await load(chain_id);
      const askedHuman = new Set([...negotiations.values()].filter((n) => n.chain_id === chain_id && n.state.state === "human_decision").map((n) => n.state.action_id));
      const settled = (a: Action) => DONE_STATES.has(a.state) && !(a.state === "accepted" && a.amount > 0);
      const open = actions.filter((a) => chain.plan.some((p) => p.action_id === a.action_id && p.option !== "keep") && !settled(a) && !askedHuman.has(a.action_id));
      if (!open.length) return;
      if (!final) {
        await deps.textHuman(chain_id, "reminder", stillWorking(open));
        return;
      }
      for (const a of open) {
        for (const n of negotiations.values()) {
          if (n.state.action_id === a.action_id) {
            n.state = { ...n.state, state: "failed" };
            stopWaiting(n.state.negotiation_id);
          }
        }
        await setState(a, "failed");
        const route = chain.plan.find((p) => p.action_id === a.action_id)?.route ?? "reversal_protocol";
        await step(chain, a, route, "failed", "No progress in time; stopped so the summary can name the next option");
      }
      await finishIfDone(chain_id);
    };
    for (const [times, final] of [[3, false], [5, true]] as const) {
      const t = setTimeout(() => check(final).catch((e) => console.error("[undo] watchdog failed:", e)), times * unit);
      t.unref?.();
    }
  }

  /** The offers in the order Proxy lists them: refunds (most money first), then store credit, then the rest. */
  function sortedOffers(offers: Offer[]): Offer[] {
    const rank = (o: Offer) => (o.kind === "partial_refund" ? 0 : o.kind === "store_credit" ? 1 : 2);
    return [...offers].sort((a, b) => rank(a) - rank(b) || b.amount - a.amount);
  }

  /** The option the human's rules point to: the best refund at or above their minimum, else credit if allowed. */
  function recommend(options: Offer[], prefs: Intent["preferences"], orderAmount: Cents, preferred: Offer | null): number | null {
    const meets = (o: Offer) =>
      (o.kind === "partial_refund" && o.amount * 100 >= prefs.min_partial_refund_pct * orderAmount) || (o.kind === "store_credit" && !prefs.no_store_credit);
    if (preferred) {
      const i = options.findIndex((o) => o.kind === preferred.kind && o.amount === preferred.amount);
      if (i >= 0 && meets(options[i]!)) return i;
    }
    const i = options.findIndex(meets);
    return i >= 0 ? i : null;
  }

  /**
   * The negotiation is paused, not stalled: no merchant timer runs (the merchant keeps its offers open) and the round
   * isn't used. The human gets every offer, numbered, with Proxy's recommendation; one reminder if they don't answer.
   */
  async function askOptions(chain: Chain, action: Action, neg: Negotiation, preferred: Offer | null) {
    const intent = await store.getIntent(action.task_id);
    const prefs = intent?.preferences ?? { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false };
    const options = sortedOffers(neg.offers.length ? neg.offers : preferred ? [preferred] : []);
    if (!options.length) {
      await setState(action, "failed");
      await step(chain, action, "reversal_protocol", "failed", "The merchant made no offer Proxy could put to the human");
      await finishIfDone(chain.chain_id);
      return;
    }
    const recommended = recommend(options, prefs, action.amount, preferred);
    const canPush = neg.state.round + 2 <= MAX_ROUNDS;
    const name = nameOf(action.merchant);
    const text = offerOptionsText(name, options, action.amount, recommended, prefs, canPush);
    neg.asked = { options, recommended, canPush, text };
    stopWaiting(neg.state.negotiation_id);
    await setState(action, "countered");
    await step(chain, action, "reversal_protocol", "pending", "Asked the human to choose between the merchant's offers", { protocol_state: "human_decision", round: neg.state.round });
    note(chain, "proxy", "options", `Proxy asked you to choose: ${options.map((o, i) => `${i + 1}) ${optionLabel(o, action.amount, name)}`).join("; ")}.`, {
      merchant: action.merchant,
      action_id: action.action_id,
      options: JSON.stringify(options.map((o) => ({ ...o, label: optionLabel(o, action.amount, name) }))),
      recommended: recommended === null ? null : recommended + 1,
      can_push: canPush,
    });
    await deps.askHumanAboutCounter(chain.chain_id, neg.state.negotiation_id, text);
    // Never accepts silently: one more text if the human hasn't answered.
    clearTimeout(neg.remind);
    const ms = deps.params.COUNTER_REMIND_MS ?? 30 * 60_000;
    neg.remind = setTimeout(() => {
      serial(neg.state.negotiation_id, async () => {
        if (neg.state.state !== "human_decision" || !neg.asked) return;
        await deps.askHumanAboutCounter(chain.chain_id, neg.state.negotiation_id, `Still waiting on your choice. ${neg.asked.text}`);
      }).catch((e) => console.error("[undo] reminder failed:", e));
    }, ms);
    neg.remind.unref?.();
  }

  /** The human chose store credit: the action is resolved as kept, with the credit recorded, and no Stripe refund. */
  async function keepAsCredit(chain: Chain, action: Action, amount: Cents) {
    await deps.lockChain(chain.chain_id, async () => {
      const c = (await store.getChain(chain.chain_id)) ?? chain;
      const plan = c.plan.map((p) => (p.action_id === action.action_id ? { ...p, credit_amount: amount } : p));
      await store.upsertChain({ ...c, plan });
    });
    await setState(action, "kept");
    await step(chain, action, "reversal_protocol", "succeeded", `Kept as ${money(amount)} store credit; no Stripe refund`, { protocol_state: "failed" });
    note(chain, "proxy", "credit", `${nameOf(action.merchant)} issued ${money(amount)} in store credit. No money moves to your card.`, { merchant: action.merchant, action_id: action.action_id, amount, of: action.amount });
    await deps.textHuman(chain.chain_id, "progress", `${nameOf(action.merchant)} issued ${money(amount)} in store credit, as you chose. No money moves to your card.`);
  }

  /** Proxy's plan, for the feed: who it will contact for each step, and how, in the order it will go. */
  function notePlan(chain: Chain, steps: PlanStep[], open: Action[]) {
    const items = steps.flatMap((p) => {
      const a = open.find((x) => x.action_id === p.action_id);
      if (!a || p.option === "keep" || p.route === "keep") return [];
      const name = nameOf(a.merchant);
      const how =
        p.route === "reversal_protocol" ? `negotiate with ${name}'s agent` :
        p.route === "email_support" ? `email ${name} support for a refund` :
        p.route === "self_serve" ? `cancel on ${name}'s site` :
        p.route === "correction" ? `send ${name} the right dates` : p.route;
      return [{ action_id: a.action_id, merchant: a.merchant, category: a.category, amount: a.amount, route: p.route, how }];
    });
    if (!items.length) return;
    note(chain, "proxy", "plan", `Proxy's plan: ${items.map((i, n) => `${n + 1}. ${i.how}`).join("; ")}.`, { steps: JSON.stringify(items) });
  }

  /**
   * Demo pacing: waits until a step is settled (done, failed, or waiting on the human's YES/NO) before the next starts.
   * A negotiation is bounded by its own timers (a follow-up, then giving up), so this never waits much past them.
   */
  async function untilSettled(action_id: string) {
    const until = Date.now() + 2.5 * deps.params.MERCHANT_REPLY_TIMEOUT + 2 * (deps.params.COUNTER_REMIND_MS ?? 0);
    const humanUntil = Date.now() + 2 * (deps.params.COUNTER_REMIND_MS ?? 0);
    while (Date.now() < until) {
      const a = await store.getAction(action_id);
      if (!a || (DONE_STATES.has(a.state) && !(a.state === "accepted" && a.amount > 0))) return;
      // Waiting on the human's choice: the showcase waits for it too (up to two reminder periods), so the options
      // text stays the newest thing on the phone until they answer.
      if ([...negotiations.values()].some((n) => n.state.action_id === action_id && n.state.state === "human_decision")) {
        if (Date.now() > humanUntil) return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function stopWaiting(negotiation_id: string) {
    clearTimeout(timers.get(negotiation_id));
    timers.delete(negotiation_id);
  }

  async function runEmailSupport(chain: Chain, action: Action) {
    const info = merchants.get(action.merchant);
    if (!info?.support_email || !merchants.hasSupportDesk(action.merchant)) {
      await setState(action, "no_agent");
      await step(chain, action, "email_support", "failed", `${action.merchant} has no support desk to email`);
      return;
    }
    const subject = `Cancel booking ${action.ref}`;
    const body = `Hello,\n\nBooking ${action.ref} (${action.summary}) was made in error for the wrong dates. Please cancel it and refund the full ${money(action.amount)}.\n\nThanks,\nProxy, for the account holder`;
    await setState(action, "requested");
    try {
      await deps.inkbox.sendEmail({ to: info.support_email, subject, body });
      await deps.logEvent({ kind: "email_out", chain_id: chain.chain_id, action_id: action.action_id, outcome: "support_request" });
    } catch (e) {
      // The mock desk below answers in-process, so a failed send (e.g. a .example address) doesn't stop the demo.
      await deps.logEvent({ kind: "email_out", chain_id: chain.chain_id, action_id: action.action_id, outcome: `support_request_not_sent:${(e as Error).name}` });
    }
    await step(chain, action, "email_support", "pending", `Emailed ${info.support_email} asking for a full refund`);
    note(chain, "proxy", "email_out", `Proxy emailed ${info.name} support: please cancel ${action.ref} and refund ${money(action.amount)}.`, { to: info.support_email, ref: action.ref, amount: action.amount, action_id: action.action_id, merchant: action.merchant });
    await pace(chain, 1, { text: `Waiting for ${info.name} support to reply…`, merchant: action.merchant, action_id: action.action_id });
    const answer = await merchants.supportEmail(action.merchant, { from: deps.proxyEmail, subject, body }, clock.now());
    note(chain, actorFor(action.merchant), "email_in", answer.approved && answer.refund_amount > 0 ? `${info.name} support: refund approved, ${money(answer.refund_amount)}.` : `${info.name} support: refund declined.`, {
      action_id: action.action_id,
      merchant: action.merchant,
      approved: answer.approved,
      amount: answer.refund_amount,
    });
    if (!answer.approved || answer.refund_amount <= 0) {
      await setState(action, "denied");
      await step(chain, action, "email_support", "failed", "The support desk did not approve a refund");
      return;
    }
    await refundAndVerify(chain, action, answer.refund_amount, "email_support", "Support desk approved the refund");
  }

  async function runCorrection(chain: Chain, intent: Intent, action: Action) {
    const info = merchants.get(action.merchant);
    if (!info?.support_email || !merchants.hasSupportDesk(action.merchant)) {
      await setState(action, "failed");
      await step(chain, action, "correction", "failed", "No one to send the correction to");
      return;
    }
    const dates = intent.constraints.dates;
    const subject = `Correction to ${action.ref}: ${action.summary}`;
    const body = `Hi,\n\nThis corrects message ${action.ref}. Please ignore the dates in it. The correct dates are ${dates?.start ?? "unchanged"}${dates?.end ? ` to ${dates.end}` : ""}.\n\nSent by Proxy on behalf of the account holder.`;
    try {
      await deps.inkbox.sendEmail({ to: info.support_email, subject, body });
      await deps.logEvent({ kind: "email_out", chain_id: chain.chain_id, action_id: action.action_id, outcome: "correction" });
    } catch (e) {
      await deps.logEvent({ kind: "email_out", chain_id: chain.chain_id, action_id: action.action_id, outcome: `correction_not_sent:${(e as Error).name}` });
    }
    note(chain, "proxy", "email_out", `Proxy emailed ${info.name}: the right dates are ${dates ? `${humanDate(dates.start)}${dates.end ? ` to ${humanDate(dates.end)}` : ""}` : "in the task"}.`, { to: info.support_email, ref: action.ref, action_id: action.action_id, merchant: action.merchant, correction: true });
    await pace(chain, 1, { text: `Waiting for ${info.name} to confirm…`, merchant: action.merchant, action_id: action.action_id });
    const answer = await merchants.supportEmail(action.merchant, { from: deps.proxyEmail, subject, body }, clock.now());
    note(chain, actorFor(action.merchant), "email_in", answer.approved ? `${info.name}: thanks, plans updated.` : `${info.name}: didn't confirm the correction.`, { approved: answer.approved, action_id: action.action_id, merchant: action.merchant, correction: true });
    if (!answer.approved) {
      await setState(action, "failed");
      await step(chain, action, "correction", "failed", "The correction was not acknowledged");
      return;
    }
    // A correction moves no money, so there is nothing for Stripe to show.
    await setState(action, "accepted");
    await step(chain, action, "correction", "succeeded", "Correction sent and acknowledged");
    await deps.textHuman(chain.chain_id, "progress", correctionStep(action, dates, info.name));
  }

  async function runStep(chain: Chain, intent: Intent, action: Action, plan: PlanStep) {
    if (deps.isFrozen()) return;
    try {
      if (plan.option === "keep" || plan.route === "keep") {
        await setState(action, "kept");
        await step(chain, action, plan.route, "skipped", "Kept: fixing it costs more than it recovers");
      } else if (plan.route === "self_serve") await runSelfServe(chain, action);
      else if (plan.route === "reversal_protocol") await runProtocol(chain, intent, action, plan);
      else if (plan.route === "email_support") await runEmailSupport(chain, action);
      else if (plan.route === "correction") await runCorrection(chain, intent, action);
      else {
        await setState(action, "failed");
        await step(chain, action, plan.route, "failed", `Route ${plan.route} is not available yet`);
      }
    } catch (e) {
      // Raw errors stay in the server log; the step records only a safe note.
      console.error(`[undo] ${action.action_id} via ${plan.route} failed:`, e);
      await setState(action, "failed");
      await step(chain, action, plan.route, "failed", "This step hit an internal error");
    }
  }

  // --- protocol messages ---

  async function applyNegotiation(neg: Negotiation, message: MerchantProtocolMessage) {
    const { chain, intent } = await load(neg.chain_id);
    const action = (await store.getAction(neg.action.action_id)) ?? neg.action;
    stopWaiting(neg.state.negotiation_id);
    // Every distinct offer stays on the table for the human's choice (typed fields only).
    const offered = message.type === "counter" ? { kind: message.kind, amount: message.amount } : message.type === "accept" && message.refund_amount > 0 && message.refund_amount < action.amount && neg.state.state !== "accepted" ? { kind: "partial_refund" as const, amount: message.refund_amount } : null;
    if (offered && Number.isInteger(offered.amount) && offered.amount > 0 && offered.amount <= action.amount && !neg.offers.some((o) => o.kind === offered.kind && o.amount === offered.amount)) neg.offers.push(offered);
    const out = logic.negotiate_step(neg.state, message, intent.preferences) as ReturnType<Logic["negotiate_step"]> & { ignored_text?: { field: string; text: string }[] };
    // Untrusted merchant text is counted, never acted on or stored.
    if (out.ignored_text?.length) await deps.logEvent({ kind: "a2a", chain_id: chain.chain_id, action_id: action.action_id, outcome: `ignored_text:${out.ignored_text.length}` });
    const next = out.next_state;
    neg.state = next;
    await store.appendStep({
      chain_id: chain.chain_id,
      action_id: action.action_id,
      route: "reversal_protocol",
      protocol_state: next.state,
      round: next.round,
      message: `Merchant ${message.type}${"amount" in message ? ` ${money(message.amount)}` : ""}${"refund_amount" in message ? ` ${money(message.refund_amount)}` : ""}; now ${next.state}`,
      outcome: next.state === "failed" || next.state === "denied" ? "failed" : "pending",
      stripe_ref: null,
      at: clock.now(),
    });

    // Proxy never accepts an offer on its own: where negotiate_step would accept (the merchant's final position), or
    // hands the decision over, the negotiation pauses and the human picks from every offer made.
    if (out.outgoing?.type === "accept_counter") {
      neg.state = { ...next, state: "human_decision", round: Math.max(1, next.round - 1) };
      await askOptions(chain, action, neg, next.last_counter);
      return;
    }
    if (next.state === "human_decision" && out.outgoing?.type === "ask_human") {
      await askOptions(chain, action, neg, null);
      return;
    }
    if (out.outgoing && out.outgoing.type !== "ask_human") {
      const outgoing = { ...out.outgoing, sent_at: clock.now() } as ProxyProtocolMessage;
      await setState(action, next.state === "accepted" ? "accepted" : "countered");
      await deps.logEvent({ kind: "a2a", chain_id: chain.chain_id, action_id: action.action_id, outcome: `out:${outgoing.type}` });
      if (!deps.isFrozen()) await sendToAgent(neg.state.negotiation_id, outgoing);
      return;
    }
    if (next.state === "refund_pending") {
      const agreed = message.type === "accept" ? message.refund_amount : (next.last_counter?.amount ?? action.amount);
      if (!deps.isFrozen()) await refundAndVerify(chain, action, agreed, "reversal_protocol", `Merchant agreed ${money(agreed)}`);
    } else if (next.state === "denied" && (await returnFlow.start(chain, action))) {
      // The merchant takes refunds through its return form: return-flow.ts carries on from here.
    } else if (next.state === "denied") {
      await setState(action, "denied");
      // The merchant's reason is untrusted text: never shown or acted on.
      await deps.textHuman(chain.chain_id, "reminder", deniedStep(action, "The summary below has your options."));
    } else if (next.state === "failed") {
      const credit = message.type === "accept" && message.refund_amount === 0;
      if (credit && neg.chosen?.kind === "store_credit") {
        // The human chose the store credit: resolved, kept as credit; nothing moves in Stripe.
        await keepAsCredit(chain, action, neg.chosen.amount);
      } else {
        await setState(action, "failed");
        if (credit) await step(chain, action, "reversal_protocol", "failed", "Store credit is not a refund; nothing was recovered in Stripe");
      }
    }
    await finishIfDone(chain.chain_id);
  }

  async function handleMerchantMessage(message: MerchantProtocolMessage, realReceivedAt?: string) {
    const neg = negotiations.get(message.negotiation_id);
    if (!neg) return;
    const { chain } = await load(neg.chain_id);
    const key = `${message.type}:${message.round}:${"amount" in message ? message.amount : "refund_amount" in message ? message.refund_amount : ""}`;
    const mark = `${neg.state.negotiation_id}:${key}`;
    if (chain.steps.some((s) => s.message.includes(`|${mark}]`))) return; // a replay after a restart
    await store.appendStep({
      chain_id: chain.chain_id,
      action_id: neg.state.action_id,
      route: "reversal_protocol",
      protocol_state: neg.state.state,
      round: message.round,
      message: `Received ${message.type} [in:${realReceivedAt ?? new Date().toISOString()}|${mark}]`,
      outcome: "pending",
      stripe_ref: null,
      at: clock.now(),
    });
    note(chain, actorFor(neg.merchant), "protocol_in", merchantLine(`${merchants.get(neg.merchant)?.name ?? neg.merchant} agent`, message, neg.state.order_amount), {
      type: message.type,
      round: message.round,
      negotiation_id: message.negotiation_id,
      merchant: neg.merchant,
      action_id: neg.action.action_id,
      kind: message.type === "counter" ? message.kind : null,
      amount: message.type === "counter" ? message.amount : message.type === "accept" ? message.refund_amount : null,
      // The merchant's own line, display only (sanitized, never acted on, never texted to the human).
      said: merchantSaid(message),
    });
    await applyNegotiation(neg, message);
  }

  return {
    async start(chain_id, picks) {
      // Under STOP the plan is still recorded; its steps wait for RESUME (see resume()).
      const { chain, intent, actions } = await load(chain_id);
      if (chain.state === "undoing" || chain.state === "reversed" || chain.state === "redo_requested" || chain.state === "redone") return;
      const chosen = picks ? new Set(picks.map((n) => chain.action_ids[n - 1]).filter((id): id is string => Boolean(id))) : null;
      const open = actions.filter((a) => !["verified", "kept"].includes(a.state) && (!chosen || chosen.has(a.action_id)));
      // plan_undo needs every action in the chain and skips the settled ones itself; PICK narrows it afterwards.
      const plan = logic.plan_undo(chain, actions, intent.preferences, clock.now()).filter((p) => open.some((a) => a.action_id === p.action_id));
      const started = await deps.lockChain(chain_id, async () => {
        const latest = (await store.getChain(chain_id))!;
        if (["undoing", "reversed", "redo_requested", "redone"].includes(latest.state)) return null;
        return store.upsertChain({ ...latest, state: "undoing", plan });
      });
      if (!started) return; // a second UNDO ALL (or a double press) while this one runs
      armWatchdog(chain_id);
      const paced = deps.params.DEMO_SEQUENTIAL ?? (deps.params.DEMO_PACE_MS ?? 0) > 0;
      // In the demo, one merchant at a time so each can be followed: the negotiation first, the correction last.
      const ORDER: Record<string, number> = { reversal_protocol: 0, email_support: 1, self_serve: 2, correction: 3 };
      const steps = paced ? [...plan].sort((a, b) => (ORDER[a.route] ?? 9) - (ORDER[b.route] ?? 9)) : plan;
      notePlan(started, steps, open);
      if (paced) {
        for (const p of steps) {
          const action = open.find((a) => a.action_id === p.action_id);
          if (!action) continue;
          await runStep(started, intent, action, p);
          await untilSettled(action.action_id);
        }
      } else {
        // Independent steps run side by side: a merchant agent that is slow to answer holds up nothing else.
        await Promise.all(
          plan.map(async (p) => {
            const action = open.find((a) => a.action_id === p.action_id);
            if (action) await runStep(started, intent, action, p);
          }),
        );
      }
      await finishIfDone(chain_id);
    },

    async decideCounter(chain_id, negotiation_id, decision) {
      await serial(negotiation_id, async () => {
        const neg = negotiations.get(negotiation_id);
        if (!neg || neg.state.state !== "human_decision" || neg.chain_id !== chain_id) return;
        const { chain } = await load(chain_id);
        const action = (await store.getAction(neg.action.action_id)) ?? neg.action;
        const asked = neg.asked;
        const d = typeof decision === "boolean" ? { accept: decision } : decision;
        const name = nameOf(action.merchant);

        if (d.push) {
          if (neg.state.round + 2 > MAX_ROUNDS) {
            // No round left to push and still accept afterwards: say so, and ask again.
            await deps.textHuman(chain_id, "reminder", `That's ${name}'s final offer: there are no rounds left to push.`);
            await askOptions(chain, action, neg, asked && asked.recommended !== null ? asked.options[asked.recommended]! : null);
            return;
          }
          clearTimeout(neg.remind);
          const round = neg.state.round + 1;
          neg.state = { ...neg.state, state: "pushed_back", round, push_backs_used: neg.state.push_backs_used + 1 };
          neg.pushByHuman = true;
          await setState(action, "countered");
          await step(chain, action, "reversal_protocol", "pending", "The human asked Proxy to keep pushing", { protocol_state: "pushed_back", round });
          await deps.textHuman(chain_id, "reminder", `Okay, pushing ${name}'s agent once more.`);
          const msg: ProxyProtocolMessage = { type: "push_back", negotiation_id, chain_id, action_id: action.action_id, round, sent_at: clock.now(), reason: "Our customer asked us to push once more. Can you do better?" };
          await deps.logEvent({ kind: "a2a", chain_id, action_id: action.action_id, outcome: "out:push_back" });
          await sendToAgent(negotiation_id, msg);
          return;
        }

        if (!d.accept && d.choice === undefined) {
          clearTimeout(neg.remind);
          neg.state = { ...neg.state, state: "denied" };
          await setState(action, "denied");
          await step(chain, action, "reversal_protocol", "failed", "The human declined the merchant's offer", { protocol_state: "denied" });
          await finishIfDone(chain_id);
          return;
        }

        // A number picks that option; a plain YES takes Proxy's recommendation (or the latest offer).
        const options = asked?.options ?? (neg.state.last_counter ? [neg.state.last_counter] : []);
        const index = d.choice !== undefined ? d.choice - 1 : (asked?.recommended ?? options.length - 1);
        const chosen = options[index];
        if (!chosen) {
          await deps.textHuman(chain_id, "reminder", `I didn't get that: reply ${options.map((_, i) => i + 1).join(" or ")}.`);
          await askOptions(chain, action, neg, asked && asked.recommended !== null ? asked.options[asked.recommended]! : null);
          return;
        }
        clearTimeout(neg.remind);
        const round = Math.min(neg.state.round + 1, MAX_ROUNDS);
        neg.state = { ...neg.state, state: "accepted", round, last_counter: chosen };
        neg.chosen = chosen;
        await setState(action, "accepted");
        await step(chain, action, "reversal_protocol", "pending", `The human chose ${optionLabel(chosen, action.amount, name)}`, { protocol_state: "accepted", round });
        note(chain, "human", "decision", `You chose: ${optionLabel(chosen, action.amount, name)}.`, { merchant: action.merchant, action_id: action.action_id, kind: chosen.kind, amount: chosen.amount, choice: index + 1 });
        await deps.textHuman(
          chain_id,
          "reminder",
          chosen.kind === "store_credit"
            ? `Okay: ${money(chosen.amount)} store credit at ${name}. Accepting it with their agent; no money moves to your card.`
            : `Okay: ${optionLabel(chosen, action.amount, name).replace(/^Refund/, "refund")}. Accepting it with ${name}'s agent; I'll text you when Stripe confirms.`,
        );
        const msg = { type: "accept_counter", negotiation_id, chain_id, action_id: action.action_id, round, sent_at: clock.now(), counter: chosen } as ProxyProtocolMessage;
        await deps.logEvent({ kind: "a2a", chain_id, action_id: action.action_id, outcome: "out:accept_counter" });
        await sendToAgent(negotiation_id, msg);
      });
    },

    onCarrierScan(scan) {
      return returnFlow.onScan(scan);
    },

    onProtocolMessage(message, realReceivedAt) {
      return serial(message.negotiation_id, () => handleMerchantMessage(message, realReceivedAt));
    },

    async resume() {
      for (const chain of await store.listChains()) {
        if (chain.state !== "undoing") continue;
        const { intent, actions } = await load(chain.chain_id);
        for (const p of chain.plan) {
          const action = actions.find((a) => a.action_id === p.action_id);
          if (action && (action.state === "found" || action.state === "planned")) await runStep(chain, intent, action, p);
        }
        await finishIfDone(chain.chain_id);
      }
    },

    async keep(chain_id) {
      const { chain, actions } = await load(chain_id);
      for (const a of actions) if (a.state !== "verified") await setState(a, "kept");
      await deps.lockChain(chain_id, async () => store.upsertChain({ ...((await store.getChain(chain_id)) ?? chain), state: "kept" }));
    },

    async lastProcessedAt() {
      let latest: string | null = null;
      for (const c of await store.listChains()) {
        for (const s of c.steps) {
          const m = IN_MARK.exec(s.message);
          if (m?.[1] && (!latest || m[1] > latest)) latest = m[1];
        }
      }
      return latest;
    },
  };
}
