// The orchestrator core: keeps chains in step with captured actions and exposes the hooks that
// capture, inkbox and stripe call. Tools and demo routes go through this object.
import type {
  Action,
  Chain,
  Clock,
  EventRow,
  Inkbox,
  Logic,
  Merchants,
  Mismatch,
  OrchestratorHooks,
  Params,
  Payments,
  Preferences,
  Sessions,
  Store,
  TaskId,
} from "../types.js";

export interface ProxyDeps {
  store: Store;
  logic: Logic;
  inkbox: Inkbox;
  payments: Payments;
  /** Null until Dhwanil's merchants are mounted; self-serve routes then stay planned. */
  merchants: Pick<Merchants, "selfServeCancel"> | null;
  sessions: Sessions;
  clock: Clock;
  params: Params;
  /** Preferences applied when log_intent omits them (the demo can override). */
  defaultPreferences: Preferences;
  /**
   * With PROXY_DEMO_ROUTES=1, every task reuses this pre-created Inkbox identity instead of getting its
   * own, so the demo needs no new identities. Null outside the demo.
   */
  demoTaskId: TaskId | null;
}

export interface Proxy extends OrchestratorHooks {
  deps: ProxyDeps;
  /** Re-runs compare and trace for a task and saves the resulting chains. */
  refreshChains(task_id: TaskId): Promise<{ mismatches: Mismatch[]; chains: Chain[] }>;
  logEvent(row: Partial<EventRow> & Pick<EventRow, "kind">): Promise<void>;
  /** True after the human replied STOP, until their next reply. No undo starts while frozen. */
  isFrozen(): boolean;
  /** Corrections waiting for the human's confirmation, by chain. */
  pendingCorrections: ReadonlyMap<string, { corrected_text: string; received_at: string }>;
}

/** Run identifiers for the events log; evals set these, the demo uses the fixed "demo" values. */
const RUN = { run_id: "demo", arm: "proxy", scenario_id: "demo", layer: "live" } as const;

export function createProxy(deps: ProxyDeps): Proxy {
  const { store, logic, clock } = deps;
  let frozen = false;
  const pendingCorrections = new Map<string, { corrected_text: string; received_at: string }>();

  async function logEvent(row: Partial<EventRow> & Pick<EventRow, "kind">) {
    await store.logEvent({
      ...RUN,
      tool_name: null,
      task_id: null,
      chain_id: null,
      action_id: null,
      outcome: null,
      tokens_in: null,
      tokens_out: null,
      timestamp: clock.now(),
      ...row,
    });
  }

  async function refreshChains(task_id: TaskId) {
    const intent = await store.getIntent(task_id);
    if (!intent) return { mismatches: [], chains: [] };
    const actions = await store.listActions(task_id);
    const byId = new Map(actions.map((a) => [a.action_id, a]));
    const mismatches = logic.compare(intent, actions);
    const traced = logic.trace(intent, actions, mismatches);
    const now = clock.now();

    const saved: Chain[] = [];
    for (const t of traced) {
      const existing = await store.getChain(t.chain_id);
      // The tightest window across the chain's actions.
      const windows = t.action_ids
        .map((id) => byId.get(id))
        .filter((a): a is Action => a !== undefined)
        .map((a) => logic.reversibility(a, now).window_ends_at)
        .filter((w): w is string => w !== null)
        .sort();
      const chain: Chain = {
        ...t,
        window_ends_at: windows[0] ?? null,
        // Keep what the orchestrator already did with this chain.
        state: existing?.state ?? t.state,
        alerts: existing?.alerts ?? t.alerts,
        steps: existing?.steps ?? t.steps,
        plan: existing?.plan ?? t.plan,
      };
      saved.push(await store.upsertChain(chain));
    }
    return { mismatches, chains: saved };
  }

  return {
    deps,
    refreshChains,
    logEvent,
    isFrozen: () => frozen,
    pendingCorrections,

    async onAction(action) {
      // Deduplicate by ref within the task: a repeated confirmation updates the same action.
      const same = (await store.listActions(action.task_id)).find((a) => a.ref === action.ref && a.ref !== "");
      const saved = await store.upsertAction(same ? { ...action, action_id: same.action_id, state: same.state } : action);
      await logEvent({ kind: action.source === "agent" ? "email_out" : "email_in", task_id: saved.task_id, action_id: saved.action_id });
      await refreshChains(saved.task_id);
    },

    async onStripeEvent(event) {
      await logEvent({ kind: "stripe_event", task_id: event.task_id, outcome: event.kind });
    },

    async onHumanReply(reply) {
      const chain_id = reply.kind === "stop" ? null : reply.chain_id;
      await logEvent({ kind: "sms_in", chain_id, outcome: reply.kind });
      if (reply.kind === "stop") {
        frozen = true;
        return;
      }
      // Any later reply from the human lifts a STOP.
      frozen = false;
      if (reply.kind === "correction") {
        // Confirmed once with the human before acting; sending that confirmation lands with the alerts flow.
        pendingCorrections.set(reply.chain_id, { corrected_text: reply.corrected_text, received_at: reply.received_at });
      }
      // UNDO ALL / PICK / KEEP / counter decisions land with the alerts flow (build step 3).
    },

    async onProtocolMessage(message) {
      // Only typed fields are logged; free text (e.g. DenyMsg.reason) is never acted on.
      await logEvent({ kind: "a2a", chain_id: message.chain_id, action_id: message.action_id, outcome: message.type });
    },
  };
}
