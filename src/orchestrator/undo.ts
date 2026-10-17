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
import { runSelfServeRoute } from "./routes/self-serve.js";

/** What a support desk answers: whether it approved and the refund it agreed. */
export interface SupportAnswer {
  approved: boolean;
  refund_amount: Cents;
}

export interface UndoMerchants extends Pick<Merchants, "selfServeCancel" | "get" | "agent"> {
  hasSupportDesk(merchant_id: MerchantId): boolean;
  supportEmail(merchant_id: MerchantId, email: { from: string; subject: string; body: string }, now: string): Promise<SupportAnswer>;
}

/** How Proxy's messages reach a merchant agent. Real mode: Inkbox. Loopback: the in-process mock agent answers. */
export interface ProtocolTransport {
  send(merchant: MerchantId, to_identity: string, message: ProxyProtocolMessage): Promise<void>;
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
  textHuman(chain_id: ChainId, kind: "chain_opened" | "reminder" | "result" | "too_late", body: string): Promise<void>;
  askHumanAboutCounter(chain_id: ChainId, negotiation_id: string, body: string): Promise<void>;
  logEvent(row: { kind: "a2a" | "email_out"; chain_id?: ChainId | null; action_id?: string | null; outcome?: string | null; task_id?: string | null }): Promise<void>;
}

export interface UndoExecutor {
  /** Starts the undo for a chain, or only for the actions numbered in `picks` (1-based, in chain order). */
  start(chain_id: ChainId, picks?: number[]): Promise<void>;
  /** The human answered a counteroffer question. */
  decideCounter(chain_id: ChainId, negotiation_id: string, accept: boolean): Promise<void>;
  /** A merchant agent's answer arrived (A2A, email or loopback). */
  onProtocolMessage(message: MerchantProtocolMessage, realReceivedAt?: string): Promise<void>;
  /** Marks the chain's actions kept and closes it. */
  keep(chain_id: ChainId): Promise<void>;
  /** Latest real-time ISO of a processed merchant message, for restarting the inbox. Null when none. */
  lastProcessedAt(): Promise<string | null>;
}

const money = (c: Cents) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const DONE_STATES = new Set<Action["state"]>(["verified", "accepted", "kept", "failed", "denied"]);
const IN_MARK = /\[in:([^|\]]+)\|[^\]]*\]$/;

export function createUndoExecutor(deps: UndoDeps): UndoExecutor {
  const { store, logic, clock, payments, merchants } = deps;
  const negotiations = new Map<string, { state: NegotiationState; merchant: MerchantId; chain_id: ChainId; action: Action }>();
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
    const chain = await store.getChain(chain_id);
    if (!chain) return;
    const plan = chain.plan.some((p) => p.action_id === action_id)
      ? chain.plan.map((p) => (p.action_id === action_id ? { ...p, refund_amount } : p))
      : [...chain.plan, { action_id, route: "reversal_protocol" as const, option: "cancel" as const, cost: 0, deadline: null, refund_amount }];
    await store.upsertChain({ ...chain, plan });
  }

  /** Refunds the agreed amount once and records whether Stripe shows it. Returns the action's new state. */
  async function refundAndVerify(chain: Chain, action: Action, agreed: Cents, route: Step["route"], note: string): Promise<Action["state"]> {
    await savePlanRefund(chain.chain_id, action.action_id, agreed);
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
    return "verified";
  }

  async function finishIfDone(chain_id: ChainId) {
    const { chain, intent, actions } = await load(chain_id);
    if (chain.state !== "undoing") return;
    const todo = actions.filter((a) => chain.plan.some((p) => p.action_id === a.action_id && p.option !== "keep"));
    if (todo.some((a) => !DONE_STATES.has(a.state))) return;
    const bad = todo.filter((a) => a.state === "failed" || a.state === "denied");
    const lines = actions.map((a) => `${a.summary}: ${a.state === "verified" ? `refunded ${money(expectedRefund(chain, a))}, verified in Stripe` : a.state === "accepted" ? "corrected" : a.state}`);
    if (bad.length) {
      await store.upsertChain({ ...chain, state: "partial" });
      await deps.textHuman(chain_id, "result", `Proxy undid part of this. ${lines.join("; ")}. ${bad.length} still needs you.`);
      return;
    }
    // The agent gets the corrected intent back through get_chain and rebooks (next_action "redo").
    await store.upsertChain({ ...chain, state: "redo_requested" });
    await deps.textHuman(chain_id, "result", `Done. ${lines.join("; ")}. Your agent has the corrected plan (${intent.goal}) and will rebook.`);
  }

  // --- routes ---

  async function runSelfServe(chain: Chain, action: Action) {
    await runSelfServeRoute({ merchants, payments, store, clock }, chain, action);
  }

  function requestFor(chain: Chain, intent: Intent, action: Action, state: NegotiationState): RequestReversal {
    const sent_at = clock.now();
    return {
      type: "request_reversal",
      negotiation_id: state.negotiation_id,
      chain_id: chain.chain_id,
      action_id: action.action_id,
      round: 1,
      sent_at,
      order: { merchant: action.merchant, ref: action.ref, amount: action.amount },
      intent: { goal: intent.goal, constraints: intent.constraints },
      what_went_wrong: `Booked ${action.summary}; the task needed ${JSON.stringify(intent.constraints.dates ?? {})}.`,
      deadline: state.deadline,
      evidence: {
        intent,
        order: action,
        confirmation_excerpt: action.summary,
        stripe_charge_id: null,
        mismatch: { action_id: action.action_id, field: "dates", expected: intent.constraints.dates?.start ?? "", actual: action.dates?.start ?? "" },
        why_wrong: "The booking does not match the task's dates.",
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
    negotiations.set(state.negotiation_id, { state, merchant: action.merchant, chain_id: chain.chain_id, action: updated });
    await step(chain, action, "reversal_protocol", "pending", "Asked the merchant agent to reverse the booking", { protocol_state: "requested", round: 1 });
    await deps.logEvent({ kind: "a2a", chain_id: chain.chain_id, action_id: action.action_id, outcome: "out:request_reversal" });
    await deps.transport.send(action.merchant, agent, request);
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
    const answer = await merchants.supportEmail(action.merchant, { from: deps.proxyEmail, subject, body }, clock.now());
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
    const answer = await merchants.supportEmail(action.merchant, { from: deps.proxyEmail, subject, body }, clock.now());
    if (!answer.approved) {
      await setState(action, "failed");
      await step(chain, action, "correction", "failed", "The correction was not acknowledged");
      return;
    }
    // A correction moves no money, so there is nothing for Stripe to show.
    await setState(action, "accepted");
    await step(chain, action, "correction", "succeeded", "Correction sent and acknowledged");
  }

  async function runStep(chain: Chain, intent: Intent, action: Action, plan: PlanStep) {
    if (deps.isFrozen()) return;
    try {
      if (plan.option === "keep") {
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

  async function applyNegotiation(neg: { state: NegotiationState; merchant: MerchantId; chain_id: ChainId; action: Action }, message: MerchantProtocolMessage) {
    const { chain, intent } = await load(neg.chain_id);
    const action = (await store.getAction(neg.action.action_id)) ?? neg.action;
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

    if (next.state === "human_decision" && out.outgoing?.type === "ask_human") {
      const c = out.outgoing.counter;
      await setState(action, "countered");
      await deps.askHumanAboutCounter(chain.chain_id, next.negotiation_id, `${action.merchant} offered ${c.kind.replace("_", " ")} of ${money(c.amount)} on ${money(action.amount)}. Reply YES to accept or NO to decline.`);
      return;
    }
    if (out.outgoing && out.outgoing.type !== "ask_human") {
      const outgoing = { ...out.outgoing, sent_at: clock.now() } as ProxyProtocolMessage;
      await setState(action, next.state === "accepted" ? "accepted" : "countered");
      await deps.logEvent({ kind: "a2a", chain_id: chain.chain_id, action_id: action.action_id, outcome: `out:${outgoing.type}` });
      if (!deps.isFrozen()) await deps.transport.send(neg.merchant, merchants.get(neg.merchant)?.agent_identity ?? neg.merchant, outgoing);
      return;
    }
    if (next.state === "refund_pending") {
      const agreed = message.type === "accept" ? message.refund_amount : (next.last_counter?.amount ?? action.amount);
      if (!deps.isFrozen()) await refundAndVerify(chain, action, agreed, "reversal_protocol", `Merchant agreed ${money(agreed)}`);
    } else if (next.state === "denied") {
      await setState(action, "denied");
    } else if (next.state === "failed") {
      const credit = message.type === "accept" && message.refund_amount === 0;
      await setState(action, "failed");
      if (credit) await step(chain, action, "reversal_protocol", "failed", "Store credit is not a refund; nothing was recovered in Stripe");
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
    await applyNegotiation(neg, message);
  }

  return {
    async start(chain_id, picks) {
      if (deps.isFrozen()) return;
      const { chain, intent, actions } = await load(chain_id);
      if (chain.state === "undoing" || chain.state === "reversed" || chain.state === "redo_requested" || chain.state === "redone") return;
      const chosen = picks ? new Set(picks.map((n) => chain.action_ids[n - 1]).filter((id): id is string => Boolean(id))) : null;
      const open = actions.filter((a) => !["verified", "kept"].includes(a.state) && (!chosen || chosen.has(a.action_id)));
      // plan_undo needs every action in the chain and skips the settled ones itself; PICK narrows it afterwards.
      const plan = logic.plan_undo(chain, actions, intent.preferences, clock.now()).filter((p) => open.some((a) => a.action_id === p.action_id));
      await store.upsertChain({ ...chain, state: "undoing", plan });
      const fresh = (await store.getChain(chain_id))!;
      for (const p of plan) {
        const action = open.find((a) => a.action_id === p.action_id);
        if (action) await runStep(fresh, intent, action, p);
      }
      await finishIfDone(chain_id);
    },

    async decideCounter(chain_id, negotiation_id, accept) {
      await serial(negotiation_id, async () => {
        const neg = negotiations.get(negotiation_id);
        if (!neg || neg.state.state !== "human_decision" || neg.chain_id !== chain_id) return;
        const { chain } = await load(chain_id);
        const action = (await store.getAction(neg.action.action_id)) ?? neg.action;
        if (!accept) {
          neg.state = { ...neg.state, state: "denied" };
          await setState(action, "denied");
          await step(chain, action, "reversal_protocol", "failed", "The human declined the merchant's offer", { protocol_state: "denied" });
          await finishIfDone(chain_id);
          return;
        }
        const round = Math.min(neg.state.round + 1, 3);
        neg.state = { ...neg.state, state: "accepted", round };
        await setState(action, "accepted");
        await step(chain, action, "reversal_protocol", "pending", "The human accepted the merchant's offer", { protocol_state: "accepted", round });
        const msg: ProxyProtocolMessage = { type: "accept_counter", negotiation_id, chain_id, action_id: action.action_id, round, sent_at: clock.now() };
        await deps.logEvent({ kind: "a2a", chain_id, action_id: action.action_id, outcome: "out:accept_counter" });
        await deps.transport.send(neg.merchant, merchants.get(neg.merchant)?.agent_identity ?? neg.merchant, msg);
      });
    },

    onProtocolMessage(message, realReceivedAt) {
      return serial(message.negotiation_id, () => handleMerchantMessage(message, realReceivedAt));
    },

    async keep(chain_id) {
      const { chain, actions } = await load(chain_id);
      for (const a of actions) if (a.state !== "verified") await setState(a, "kept");
      await store.upsertChain({ ...chain, state: "kept" });
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
