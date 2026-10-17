// The six tools and the mistakes resource, wired to Store, Logic, Inkbox and Payments through the
// orchestrator. Each returns ok(...) or fail(...), so every error follows the error contract.
import { createHash } from "node:crypto";
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
import { fail, ok } from "./result.js";

const CLOSED_CHAIN_STATES = new Set<Chain["state"]>(["closed", "kept", "redone", "expired"]);

function taskIdFor(key: string): string {
  return "task_" + createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function sameIntent(a: Pick<Intent, "goal" | "constraints" | "preferences">, b: Pick<Intent, "goal" | "constraints" | "preferences">) {
  return JSON.stringify([a.goal, a.constraints, a.preferences]) === JSON.stringify([b.goal, b.constraints, b.preferences]);
}

export function createToolHandlers(getProxy: () => Proxy) {
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

  async function planFor(p: Proxy, chains: Chain[], preferences: Intent["preferences"]): Promise<PlanStep[]> {
    const now = p.deps.clock.now();
    return chains.flatMap((c) => p.deps.logic.plan_undo(c, preferences, now));
  }

  return {
    async log_intent(input: LogIntentInput) {
      const p = getProxy();
      const { store, inkbox, clock, sessions, defaultPreferences } = p.deps;
      const preferences = { ...defaultPreferences, ...input.preferences };
      const existing = await store.getIntentByIdempotencyKey(input.idempotency_key);
      if (existing) {
        if (!sameIntent(existing, { goal: input.goal, constraints: input.constraints, preferences })) {
          return fail("idempotency_conflict", "This idempotency_key was already used with a different intent. Use a new key for a new task.", false, "fix_now");
        }
        sessions.touch(existing.task_id);
        return ok({ task_id: existing.task_id, task_email: existing.task_email });
      }
      const task_id = taskIdFor(input.idempotency_key);
      let task_email: string;
      try {
        ({ task_email } = await inkbox.createTaskAddress(task_id));
      } catch {
        return fail("upstream_unavailable", "Could not create the task email address. Retry shortly.", true, "retry");
      }
      const intent: Intent = { task_id, task_email, goal: input.goal, constraints: input.constraints, preferences, created_at: clock.now() };
      await store.putIntent(intent, input.idempotency_key);
      sessions.touch(task_id);
      await p.logEvent({ kind: "tool", tool_name: "log_intent", task_id, outcome: "ok" });
      return ok({ task_id, task_email });
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
      return ok(logic.reversibility(preview, now));
    },

    async review({ task_id }: ReviewInput) {
      const p = getProxy();
      const { store, sessions } = p.deps;
      const intent = await store.getIntent(task_id);
      if (!intent) return fail("not_found", `No task ${task_id}. Call log_intent first and use its task_id.`, false, "fix_now");
      sessions.touch(task_id);
      const { mismatches, chains } = await p.refreshChains(task_id);
      const actions = await store.listActions(task_id);
      const plan = await planFor(p, chains, intent.preferences);
      await p.logEvent({ kind: "tool", tool_name: "review", task_id, outcome: mismatches.length ? "chain_open" : "clean" });
      return ok({
        status: mismatches.length > 0 ? ("chain_open" as const) : ("clean" as const),
        mismatches,
        fixable_now: fixable(p, task_id, actions, mismatches, plan),
        chain_ids: chains.map((c) => c.chain_id),
        evidence_seen: await store.countEvidence(task_id),
      });
    },

    async undo({ action_ids, reason }: UndoInput) {
      const p = getProxy();
      const { store, sessions, clock, merchants } = p.deps;
      const accepted: ActionId[] = [];
      const requires_human: ActionId[] = [];
      let chain_id: string | null = null;

      for (const id of action_ids) {
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
        // Enforce the self-undo rule here too, not just in review.
        const { mismatches, chains } = await p.refreshChains(action.task_id);
        const plan = await planFor(p, chains, intent.preferences);
        const actions = await store.listActions(action.task_id);
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
          await runSelfServeRoute({ merchants, payments: p.deps.payments, store, clock }, chain, { ...action, state: "planned" });
        }
      }
      await p.logEvent({ kind: "tool", tool_name: "undo", chain_id, outcome: `accepted:${accepted.length}` });
      return ok({ accepted, requires_human, chain_id });
    },

    async get_chain({ chain_id }: GetChainInput) {
      const p = getProxy();
      const { store, logic, clock } = p.deps;
      const chain = await store.getChain(chain_id);
      if (!chain) return fail("not_found", `No chain ${chain_id}. Use a chain_id from review or list_chains.`, false, "fix_now");
      const intent = await store.getIntent(chain.task_id);
      const plan = intent ? logic.plan_undo(chain, intent.preferences, clock.now()) : [];
      const routeOf = new Map(plan.map((s) => [s.action_id, s.route]));
      const actions: ChainActionView[] = [];
      for (const id of chain.action_ids) {
        const a = await store.getAction(id);
        if (!a) continue;
        actions.push({
          action_id: a.action_id,
          merchant: a.merchant,
          category: a.category,
          summary: a.summary,
          amount: a.amount,
          state: a.state,
          route: routeOf.get(a.action_id) ?? null,
          stripe_verified: a.state === "verified",
        });
      }
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
              instruction: `Rebook ${actions.map((a) => a.category).join(", ")} to match the intent, using ${intent.task_email}.`,
              redo_categories: [...new Set(actions.map((a) => a.category))],
            }
          : undefined;
      return ok({
        chain_id: chain.chain_id,
        state: chain.state,
        actions,
        money_at_risk: chain.money_at_risk,
        window_ends_at: chain.window_ends_at,
        rounds: chain.steps.reduce((m, s) => Math.max(m, s.round), 0),
        ...(redo ? { redo } : {}),
        next_action,
      });
    },

    async list_chains({ task_id }: ListChainsInput) {
      const { store, logic, clock } = getProxy().deps;
      const open = (await store.listChains(task_id)).filter((c) => !CLOSED_CHAIN_STATES.has(c.state));
      const chains: ChainSummary[] = [];
      for (const c of logic.rank(open, clock.now())) {
        const root = await store.getAction(c.root_action_id);
        chains.push({
          chain_id: c.chain_id,
          task_id: c.task_id,
          state: c.state,
          money_at_risk: c.money_at_risk,
          window_ends_at: c.window_ends_at,
          action_count: c.action_ids.length,
          root_summary: root?.summary ?? c.root_action_id,
        });
      }
      return ok({ chains });
    },

    async mistakes() {
      return { lessons: await getProxy().deps.store.listLessons() };
    },
  };
}
