// The orchestrator core: keeps chains in step with captured actions and exposes the hooks that
// capture, inkbox and stripe call. Tools and demo routes go through this object.
import type {
  Action,
  Alert,
  Chain,
  ChainId,
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
  /** The one human number (HUMAN_PHONE); empty until it is registered. */
  humanNumber: string;
  /**
   * With PROXY_DEMO_ROUTES=1: the pre-created Inkbox identity every demo run reuses (identityTaskId,
   * e.g. task_demo -> task-demo@...), and the current run's task id (task_demo_1, task_demo_2, ...).
   * Each reset starts a new task id, so old rows stay as history. Null outside the demo.
   */
  demo: DemoTask | null;
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
  /** Connects Sarah's human channel (created after the orchestrator, since it calls the orchestrator's hooks). */
  setHumanChannel(channel: HumanChannelLink): void;
  /**
   * Texts the human about a chain and records the alert on it. Replies are matched to the most
   * recently alerted open chain, so every text to the human must go through here.
   */
  textHuman(chain_id: ChainId, kind: Alert["kind"], body: string): Promise<void>;
  /** Asks the human about a counteroffer; their next YES/NO is read as that decision. */
  askHumanAboutCounter(chain_id: ChainId, negotiation_id: string, body: string): Promise<void>;
  /** The open chain with the most recent alert, which an unaddressed reply belongs to. */
  mostRecentlyAlertedOpenChain(): Promise<Chain | null>;
  /** Demo only: starts a new demo run with the next unused task id (task_demo_1, task_demo_2, ...). */
  startDemoTask(): Promise<TaskId>;
}

export interface DemoTask {
  identityTaskId: TaskId;
  current: TaskId | null;
}

/** The part of Sarah's HumanChannel the orchestrator calls. */
export interface HumanChannelLink {
  expectCounterDecision(chain_id: ChainId, negotiation_id: string): void;
}

const OPEN_STATES = new Set<Chain["state"]>(["detected", "alerted", "undoing", "partial"]);

/** Run identifiers for the events log; evals set these, the demo uses the fixed "demo" values. */
const RUN = { run_id: "demo", arm: "proxy", scenario_id: "demo", layer: "live" } as const;

export function createProxy(deps: ProxyDeps): Proxy {
  const { store, logic, clock } = deps;
  let frozen = false;
  let humanChannel: HumanChannelLink | null = null;
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

  async function mostRecentlyAlertedOpenChain(): Promise<Chain | null> {
    const lastAlert = (c: Chain) => c.alerts.reduce((t, a) => Math.max(t, Date.parse(a.sent_at)), 0);
    const open = (await store.listChains()).filter((c) => OPEN_STATES.has(c.state) && c.alerts.length > 0);
    return open.sort((a, b) => lastAlert(b) - lastAlert(a))[0] ?? null;
  }

  async function textHuman(chain_id: ChainId, kind: Alert["kind"], body: string) {
    const chain = await store.getChain(chain_id);
    if (!chain) throw new Error(`No chain ${chain_id}`);
    if (!deps.humanNumber) throw new Error("HUMAN_PHONE is not set; the human can't be texted");
    await deps.inkbox.sendText("sms", deps.humanNumber, body);
    const alert: Alert = { channel: "sms", kind, body, sent_at: clock.now() };
    await store.upsertChain({
      ...chain,
      alerts: [...chain.alerts, alert],
      state: chain.state === "detected" && kind === "chain_opened" ? "alerted" : chain.state,
    });
  }

  async function startDemoTask(): Promise<TaskId> {
    const demo = deps.demo;
    if (!demo) throw new Error("Not in demo mode");
    // The next id with no stored intent, so runs never collide with rows from earlier server runs.
    let n = 1;
    while (await store.getIntent(`${demo.identityTaskId}_${n}`)) n += 1;
    demo.current = `${demo.identityTaskId}_${n}`;
    return demo.current;
  }

  return {
    deps,
    refreshChains,
    mostRecentlyAlertedOpenChain,
    startDemoTask,
    textHuman,
    setHumanChannel(channel) {
      humanChannel = channel;
    },
    async askHumanAboutCounter(chain_id, negotiation_id, body) {
      // Tell the channel first, so a fast reply can't arrive before it knows what YES/NO means.
      humanChannel?.expectCounterDecision(chain_id, negotiation_id);
      await textHuman(chain_id, "reminder", body);
    },
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

    async onHumanReply(incoming) {
      // A reply that names no open chain belongs to the most recently alerted open chain.
      let reply = incoming;
      if (reply.kind !== "stop") {
        const named = await store.getChain(reply.chain_id);
        if (!named || !OPEN_STATES.has(named.state)) {
          const current = await mostRecentlyAlertedOpenChain();
          if (current) reply = { ...reply, chain_id: current.chain_id };
        }
      }
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
