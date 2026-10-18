// The six tools and the mistakes resource, wired to Store, Logic, Inkbox and Payments through the
// orchestrator. Each returns ok(...) or fail(...), so every error follows the error contract.
import { createHash } from "node:crypto";
import { expectedRefund } from "../orchestrator/refunds.js";
import { actionLabel, humanDate, money } from "../orchestrator/copy.js";
import { checkIntent } from "../orchestrator/intent-words.js";
import type { SandboxLookup } from "../orchestrator/sandbox.js";
import { textGetChain, textListChains, textLogIntent, textReversibility, textReview, textUndo } from "./text.js";
import { checkSelfUndo } from "../orchestrator/self-undo.js";
import { runSelfServeRoute } from "../orchestrator/routes/self-serve.js";
import type { Proxy } from "../orchestrator/proxy.js";
import type {
  Action,
  ActionId,
  Chain,
  ChainActionView,
  ChainSummary,
  GetChainInput,
  Intent,
  ListChainsInput,
  LogIntentInput,
  Mismatch,
  NextAction,
  PlanStep,
  RedoInstruction,
  ReversibilityInput,
  ReviewInput,
  UndoInput,
} from "../types.js";
import { TASK_ID_PATTERN } from "../types.js";
import { fail, ok } from "./result.js";

const withMeta = <R extends object>(result: R, meta: LiveChainMeta) => ({ ...result, _meta: { ...meta } });

const CLOSED_CHAIN_STATES = new Set<Chain["state"]>(["closed", "kept", "redone", "expired"]);

function taskIdFor(key: string): string {
  return "task_" + createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function sameIntent(a: Pick<Intent, "goal" | "constraints" | "preferences">, b: Pick<Intent, "goal" | "constraints" | "preferences">) {
  return JSON.stringify([a.goal, a.constraints, a.preferences]) === JSON.stringify([b.goal, b.constraints, b.preferences]);
}

/** View-only data for the live-chain widget, sent as result `_meta` (not part of the tool contract). */
export interface LiveChainMeta {
  /** Server time on the (possibly simulated) clock, so the widget can count down. */
  server_now: string;
  /** Each action's undo window from Logic.reversibility; null when there is none. */
  windows: Record<string, string | null>;
  /** Amount Stripe shows refunded, for verified actions only. */
  recovered: Record<string, number>;
  /** Message actions whose correction was sent and acknowledged; their rows are done (green) with no money. */
  corrected: string[];
  /** Short row titles, e.g. "Hotel · Harborview Hotel · Nov 3 to Nov 6" (receipt summaries can be long). */
  labels: Record<string, string>;
  /** The last few agent-to-agent lines for this chain, in plain English (from the demo feed). */
  protocol: Array<{ at: string; actor: string; text: string }>;
}

/** "Rebook the flight, hotel and transfer for Nov 13 to Nov 16, using <task email>. The host already has the right dates." */
function redoInstruction(intent: { task_email: string; constraints: { dates?: { start: string; end?: string } } }, members: Action[]): string {
  const booked = [...new Set(members.filter((a) => a.category !== "message").map((a) => a.category))];
  const list = booked.length > 1 ? `${booked.slice(0, -1).join(", ")} and ${booked.at(-1)}` : (booked[0] ?? "booking");
  const d = intent.constraints.dates;
  const when = d ? ` for ${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "";
  const told = members.some((a) => a.category === "message") ? " Messages were already corrected; don't resend them." : "";
  return `Rebook the ${list}${when}, using ${intent.task_email}.${told}`;
}

/** Where the human's answer about the intent stands, for a repeated log_intent with the same key. */
async function intentStatus(p: Proxy, task_id: string) {
  const entry = p.intentCheckFor?.(task_id);
  if (!entry) return {};
  const intent_check = { status: entry.status, understood: entry.check.understood, said: entry.check.said };
  if (entry.status === "disagrees") return { intent_check, next_action: "wait_for_human" as const };
  const intent = await p.deps.store.getIntent(task_id);
  return { intent_check, ...(intent ? { constraints: intent.constraints } : {}) };
}

const merchantName = (p: Proxy, id: string) => p.deps.merchants?.get?.(id)?.name ?? id;

export function createToolHandlers(getProxy: () => Proxy, sandboxes?: SandboxLookup) {
  // Refunded amounts don't change once Stripe verified them, so each is fetched once.
  const recoveredCache = new Map<string, number>();
  /** Mismatches already written to each runtime's demo feed, so repeated reviews don't repeat them. */
  const notedBy = new WeakMap<Proxy, Set<string>>();
  /** Which mismatched actions the agent may undo itself right now. */
  function fixable(p: Proxy, task_id: string, actions: Action[], mismatches: Mismatch[], plan: PlanStep[]): ActionId[] {
    const { logic, sessions, clock } = p.deps;
    const flagged = new Set(mismatches.map((m) => m.action_id));
    const routeOf = new Map(plan.map((s) => [s.action_id, s.route]));
    const now = clock.now();
    return actions
      .filter(
        (a) =>
          checkSelfUndo({
            flagged: flagged.has(a.action_id),
            route: routeOf.get(a.action_id) ?? null,
            reversibility: logic.reversibility(a, now),
            session_active: sessions.isActive(task_id),
            now,
          }).allowed,
      )
      .map((a) => a.action_id);
  }

  function planFor(p: Proxy, chains: Chain[], actions: Action[], preferences: Intent["preferences"]): PlanStep[] {
    const now = p.deps.clock.now();
    return chains.flatMap((c) => p.deps.logic.plan_undo(c, actions.filter((a) => c.action_ids.includes(a.action_id)), preferences, now));
  }

  return {
    async log_intent(input: LogIntentInput) {
      const p = getProxy();
      const { store, inkbox, clock, sessions, defaultPreferences } = p.deps;
      const preferences = { ...defaultPreferences, ...input.preferences };
      // A demo run scopes keys to the run, so the scripted agent can reuse its key every run.
      const demo = p.deps.demo;
      const runId = demo ? (demo.current ?? (await p.startDemoTask())) : null;
      const key = runId ? `${runId}:${input.idempotency_key}` : input.idempotency_key;
      const existing = await store.getIntentByIdempotencyKey(key);
      if (existing) {
        if (!sameIntent(existing, { goal: input.goal, constraints: input.constraints, preferences })) {
          return fail("idempotency_conflict", "This idempotency_key was already used with a different intent. Use a new key for a new task.", false, "fix_now");
        }
        sessions.touch(existing.task_id);
        const again = { task_id: existing.task_id, task_email: existing.task_email, ...(await intentStatus(p, existing.task_id)) };
        return ok(again, textLogIntent(again));
      }
      // Each task gets its own Inkbox identity. A demo run gets a fresh task id but reuses the demo identity.
      const task_id = runId ?? taskIdFor(input.idempotency_key);
      const identityTask = demo ? demo.identityTaskId : task_id;
      for (const id of new Set([task_id, identityTask])) {
        if (!TASK_ID_PATTERN.test(id)) {
          return fail("invalid_input", `Task id ${id} must use only lowercase letters, digits and underscores.`, false, "fix_now");
        }
      }
      if (demo && (await store.getIntent(task_id))) {
        return fail("upstream_unavailable", `Demo run ${task_id} already has a task. Ask the operator to reset the demo (POST /demo/reset), then call log_intent again.`, false, "stop");
      }
      let task_email: string;
      try {
        // Sarah's Inkbox client gets or creates the identity task_<id> -> task-<id>@...
        ({ task_email } = await inkbox.createTaskAddress(identityTask));
      } catch (e) {
        // The agent gets the safe message; the real cause goes to the server log (never a key: the SDK's errors don't carry one).
        console.error(`[log_intent] createTaskAddress(${identityTask}) failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
        return fail("upstream_unavailable", "Could not create the task email address. Retry shortly.", true, "retry");
      }
      const intent: Intent = { task_id, task_email, goal: input.goal, constraints: input.constraints, preferences, created_at: clock.now() };
      await store.putIntent(intent, key);
      sessions.touch(task_id);
      await p.logEvent({ kind: "tool", tool_name: "log_intent", task_id, outcome: "ok" });
      const d = input.constraints.dates;
      p.note?.({
        task_id,
        chain_id: null,
        actor: "agent",
        kind: "intent",
        text: `Agent started a task: ${input.goal}${d ? ` (${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""})` : ""}.`,
        data: { goal: input.goal, start: d?.start ?? null, end: d?.end ?? null, budget_total: input.constraints.budget_total ?? null },
      });
      // The human's own words, if given: a disagreement is put to the human; agreement sends nothing.
      const check = checkIntent(input.constraints, input.original_request, Number(clock.now().slice(0, 4)));
      if (check.status === "disagrees") {
        await p.askAboutIntent(task_id, check);
        const asked = { task_id, task_email, intent_check: { status: check.status, understood: check.understood, said: check.said }, next_action: "wait_for_human" as const };
        return ok(asked, textLogIntent(asked));
      }
      const created = { task_id, task_email, ...(input.original_request !== undefined ? { intent_check: { status: check.status } } : {}) };
      return ok(created, textLogIntent(created));
    },

    async reversibility(input: ReversibilityInput) {
      const { logic, clock } = getProxy().deps;
      const now = clock.now();
      const preview: Action = {
        action_id: "preview",
        task_id: "preview",
        merchant: input.merchant,
        category: input.category,
        summary: "",
        amount: input.amount,
        ...(input.dates ? { dates: input.dates } : {}),
        ref: "",
        source: "agent",
        received_at: now,
        state: "found",
      };
      const rev = logic.reversibility(preview, now);
      return ok(rev, textReversibility(rev));
    },

    async review({ task_id }: ReviewInput) {
      const p = sandboxes?.forTask(task_id) ?? getProxy();
      const { store, sessions } = p.deps;
      const intent = await store.getIntent(task_id);
      if (!intent) return fail("not_found", `No task ${task_id}. Call log_intent first and use its task_id.`, false, "fix_now");
      sessions.touch(task_id);
      const { mismatches, chains } = await p.refreshChains(task_id);
      const actions = await store.listActions(task_id);
      const plan = planFor(p, chains, actions, intent.preferences);
      await p.logEvent({ kind: "tool", tool_name: "review", task_id, outcome: mismatches.length ? "chain_open" : "clean" });
      const noted = notedBy.get(p) ?? new Set<string>();
      notedBy.set(p, noted);
      for (const m of mismatches) {
        const key = `${m.action_id}:${m.field}`;
        if (noted.has(key)) continue;
        noted.add(key);
        const a = actions.find((x) => x.action_id === m.action_id);
        p.note?.({
          task_id,
          chain_id: chains.find((c) => c.action_ids.includes(m.action_id))?.chain_id ?? null,
          actor: "proxy",
          kind: "mismatch",
          text: `Proxy: ${a ? (a.category === "message" ? `the email to ${merchantName(p, a.merchant)}` : `the ${a.category} with ${merchantName(p, a.merchant)}`) : m.action_id} has the wrong ${m.field} (${humanDate(m.actual)}, not ${humanDate(m.expected)}).`,
          data: { action_id: m.action_id, field: m.field, expected: String(m.expected), actual: String(m.actual) },
        });
      }
      const reviewed = {
        status: mismatches.length > 0 ? ("chain_open" as const) : ("clean" as const),
        mismatches,
        fixable_now: fixable(p, task_id, actions, mismatches, plan),
        chain_ids: chains.map((c) => c.chain_id),
        evidence_seen: await store.countEvidence(task_id),
      };
      return ok(reviewed, textReview(reviewed));
    },

    async undo({ action_ids, reason }: UndoInput) {
      const p = getProxy();
      const { store, sessions, clock, merchants } = p.deps;
      const accepted: ActionId[] = [];
      const requires_human: ActionId[] = [];
      let chain_id: string | null = null;

      for (const id of action_ids) {
        // STOP from the human freezes all undo activity, including the agent's self-undo.
        if (p.isFrozen()) {
          requires_human.push(id);
          continue;
        }
        const action = await store.getAction(id);
        if (!action) {
          requires_human.push(id);
          continue;
        }
        const intent = await store.getIntent(action.task_id);
        if (!intent) {
          requires_human.push(id);
          continue;
        }
        sessions.touch(action.task_id);
        // A repeated undo is successful once the original attempt has been Stripe-verified.
        // Real Logic intentionally omits settled actions from new mismatch plans, so handle
        // this idempotent replay before asking Logic whether the action is still fixable.
        if (action.state === "verified") {
          const existingChain = (await store.listChains(action.task_id)).find((candidate) => candidate.action_ids.includes(id));
          if (existingChain) {
            accepted.push(id);
            chain_id = existingChain.chain_id;
          } else {
            requires_human.push(id);
          }
          continue;
        }
        // Enforce the self-undo rule here too, not just in review.
        const { mismatches, chains } = await p.refreshChains(action.task_id);
        const actions = await store.listActions(action.task_id);
        const plan = planFor(p, chains, actions, intent.preferences);
        if (!fixable(p, action.task_id, actions, mismatches, plan).includes(id)) {
          requires_human.push(id);
          continue;
        }
        const chain = chains.find((c) => c.action_ids.includes(id));
        if (!chain) {
          requires_human.push(id);
          continue;
        }
        accepted.push(id);
        chain_id = chain.chain_id;
        // Idempotent: an action already being undone is not started again.
        if (action.state !== "found") continue;
        await store.upsertAction({ ...action, state: "planned" });
        await store.upsertChain({ ...chain, state: "undoing" });
        await store.appendStep({
          chain_id: chain.chain_id,
          action_id: id,
          route: "self_serve",
          protocol_state: null,
          round: 0,
          message: `Self-undo requested by the agent: ${reason}`,
          outcome: "pending",
          stripe_ref: null,
          at: clock.now(),
        });
        if (merchants) {
          p.note?.({ task_id: action.task_id, chain_id: chain.chain_id, actor: "agent", kind: "self_undo", text: `Agent undid its own ${action.category} with ${merchantName(p, action.merchant)} (free under the airline's 24-hour rule).`, data: { action_id: id, amount: action.amount } });
          const r = await runSelfServeRoute({ merchants, payments: p.deps.payments, store, clock }, chain, { ...action, state: "planned" });
          if (r.action.state === "verified") {
            p.note?.({ task_id: action.task_id, chain_id: chain.chain_id, actor: "stripe", kind: "stripe_refund", text: `${p.deps.paymentsName ?? "Stripe"}: ${money(action.amount)} refunded on the ${p.deps.merchants.get(action.merchant)?.name ?? action.merchant} charge, confirmed.`, data: { action_id: id, merchant: action.merchant, amount: action.amount, of: action.amount, refund_id: r.step.stripe_ref } });
          }
        }
        // The agent's undo covers only this action. If anything else in the chain is still open, the chain goes
        // back to waiting for the human (and gets its alert); if everything is settled, it is reversed.
        const after = await store.getChain(chain.chain_id);
        if (after?.state === "undoing") {
          const states = await Promise.all(after.action_ids.map(async (aid) => (await store.getAction(aid))?.state));
          const settled = states.every((st) => st === "verified" || st === "kept");
          await store.upsertChain({ ...after, state: settled ? "reversed" : "detected" });
        }
      }
      await p.logEvent({ kind: "tool", tool_name: "undo", chain_id, outcome: `accepted:${accepted.length}` });
      return ok({ accepted, requires_human, chain_id }, textUndo({ accepted, requires_human, chain_id }));
    },

    async get_chain({ chain_id }: GetChainInput) {
      const p = sandboxes?.forChain(chain_id) ?? getProxy();
      const { store, logic, clock } = p.deps;
      const chain = await store.getChain(chain_id);
      if (!chain) return fail("not_found", `No chain ${chain_id}. Use a chain_id from review or list_chains.`, false, "fix_now");
      const intent = await store.getIntent(chain.task_id);
      const members: Action[] = [];
      for (const id of chain.action_ids) {
        const a = await store.getAction(id);
        if (a) members.push(a);
      }
      const plan = intent ? logic.plan_undo(chain, members, intent.preferences, clock.now()) : [];
      // Settled actions drop out of a fresh plan; show the route each one actually took.
      const routeOf = new Map<string, PlanStep["route"]>([
        ...chain.steps.map((s) => [s.action_id, s.route] as const),
        ...chain.plan.map((s) => [s.action_id, s.route] as const),
        ...plan.map((s) => [s.action_id, s.route] as const),
      ]);
      const next_action: NextAction =
        chain.state === "reversed" || chain.state === "redo_requested"
          ? "redo"
          : CLOSED_CHAIN_STATES.has(chain.state)
            ? "stop"
            : "wait_for_human";
      const redo: RedoInstruction | undefined =
        next_action === "redo" && intent
          ? {
              task_id: intent.task_id,
              task_email: intent.task_email,
              corrected_intent: { goal: intent.goal, constraints: intent.constraints },
              instruction: redoInstruction(intent, members),
              redo_categories: [...new Set(members.filter((a) => a.category !== "message").map((a) => a.category))],
            }
          : undefined;
      const now = clock.now();
      const windows: LiveChainMeta["windows"] = {};
      const recovered: LiveChainMeta["recovered"] = {};
      const verifiedByStripe = new Set<ActionId>();
      for (const a of members) {
        windows[a.action_id] = logic.reversibility(a, now).window_ends_at;
        const expected = expectedRefund(chain, a);
        if (a.state !== "verified" || expected <= 0) continue;
        if (!recoveredCache.has(a.action_id)) {
          try {
            const charge = await p.deps.payments.findChargeForAction(a);
            if (charge) {
              const verification = await p.deps.payments.verifyRefund(charge, expected);
              if (verification.verified && verification.refunded_amount === expected) {
                recoveredCache.set(a.action_id, verification.refunded_amount);
              }
            }
          } catch {
            // Stripe unreachable: show nothing rather than a guess; the next poll retries.
          }
        }
        const amount = recoveredCache.get(a.action_id);
        if (amount === expected) {
          recovered[a.action_id] = amount;
          verifiedByStripe.add(a.action_id);
        }
      }
      const actions: ChainActionView[] = members.map((a) => ({
        action_id: a.action_id,
        merchant: a.merchant,
        category: a.category,
        summary: a.summary,
        amount: a.amount,
        state: a.state,
        route: routeOf.get(a.action_id) ?? null,
        stripe_verified: verifiedByStripe.has(a.action_id),
      }));
      const corrected = members
        .filter((a) => a.amount === 0 && a.state === "accepted" && chain.steps.some((s) => s.action_id === a.action_id && s.route === "correction" && s.outcome === "succeeded"))
        .map((a) => a.action_id);
      const protocol = (p.feed?.list(chain.task_id) ?? [])
        .filter((e) => e.chain_id === chain.chain_id && (e.kind === "protocol_in" || e.kind === "protocol_out" || (e.kind === "stripe_refund" && e.data.action_id && members.some((a) => a.action_id === e.data.action_id && a.merchant === "hotel"))))
        .slice(-6)
        .map((e) => ({ at: e.at, actor: e.actor, text: e.text }));
      const labels: LiveChainMeta["labels"] = {};
      for (const a of members) labels[a.action_id] = actionLabel(a, merchantName(p, a.merchant));
      const meta: LiveChainMeta = { server_now: now, windows, recovered, corrected, labels, protocol };
      const view = {
        chain_id: chain.chain_id,
        state: chain.state,
        actions,
        money_at_risk: chain.money_at_risk,
        window_ends_at: chain.window_ends_at,
        rounds: chain.steps.reduce((m, s) => Math.max(m, s.round), 0),
        ...(redo ? { redo } : {}),
        next_action,
      };
      return withMeta(ok(view, textGetChain(view, recovered, corrected, p.deps.paymentsName)), meta);
    },

    async list_chains({ task_id }: ListChainsInput) {
      const { store, logic, clock, demo } = getProxy().deps;
      const summarize = async (st: typeof store, list: Chain[]) => {
        const out: ChainSummary[] = [];
        for (const c of list) {
          const root = await st.getAction(c.root_action_id);
          out.push({
            chain_id: c.chain_id,
            task_id: c.task_id,
            state: c.state,
            money_at_risk: c.money_at_risk,
            window_ends_at: c.window_ends_at,
            action_count: c.action_ids.length,
            root_summary: root?.summary ?? c.root_action_id,
          });
        }
        return out;
      };
      // Sandbox runs (try_proxy_demo) are listed whatever their state, so a finished example is always there.
      const sandboxed: ChainSummary[] = [];
      for (const c of sandboxes ? await sandboxes.chains() : []) {
        if (task_id !== undefined && c.task_id !== task_id) continue;
        const sp = sandboxes!.forTask(c.task_id);
        if (sp) sandboxed.push(...(await summarize(sp.deps.store, [c])));
      }
      // In the demo, only the current run's chains; earlier runs stay in the Store as history.
      const scope = task_id ?? demo?.current ?? undefined;
      let mine: ChainSummary[] = [];
      if (!(demo && task_id === undefined && !demo.current)) {
        const open = (await store.listChains(scope)).filter((c) => !CLOSED_CHAIN_STATES.has(c.state));
        mine = await summarize(store, logic.rank(open, clock.now()));
      }
      const chains = [...mine, ...sandboxed];
      return ok({ chains }, textListChains(chains));
    },

    async mistakes() {
      return { lessons: await getProxy().deps.store.listLessons() };
    },
  };
}
