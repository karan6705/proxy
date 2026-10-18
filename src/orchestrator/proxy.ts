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
  Intent,
  Logic,
  Mismatch,
  OrchestratorHooks,
  Params,
  Payments,
  Preferences,
  Sessions,
  Store,
  TaskId,
} from "../types.js";
import { chainAlert, chainMoney, correctedDates, humanDate, money } from "./copy.js";
import { intentAnswer, intentQuestion } from "./intent-words.js";
import { createFeed, type Feed, type FeedEntry } from "./feed.js";
import type { IntentCheck } from "./intent-words.js";
import type { IntentUpdates } from "./intent-store.js";
import { createUndoExecutor, undoneByAgent, type ProtocolTransport, type UndoExecutor, type UndoMerchants } from "./undo.js";

export interface ProxyDeps {
  store: Store;
  logic: Logic;
  inkbox: Inkbox;
  payments: Payments;
  merchants: UndoMerchants;
  /** How Proxy's protocol messages reach a merchant agent. */
  transport: ProtocolTransport;
  /** Address Proxy's support emails come from. */
  proxyEmail: string;
  /** Where the human is texted. Defaults to iMessage; the human can reply on either. */
  humanChannel?: "sms" | "imessage";
  /** False when HUMAN_PHONE isn't set: alerts are recorded on the chain but nothing is sent. */
  canTextHuman?: boolean;
  /** Real ms to wait after the last captured action before texting about a new chain, so one text covers late arrivals. */
  alertSettleMs?: number;
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
  /** What refunds are confirmed in ("Stripe", or "Stripe (simulated)"). */
  paymentsName?: string;
  /** The demo feed (GET /demo/feed). Created if not given. */
  feed?: Feed;
  /** Demo only: called once a chain is reversed, so the demo agent can rebook with the corrected intent. */
  onRedoRequested?: (chain: Chain) => Promise<void>;
}

export interface Proxy extends OrchestratorHooks {
  deps: ProxyDeps;
  feed: Feed;
  /** Adds a line to the demo feed. */
  note(entry: Omit<FeedEntry, "seq" | "at"> & { at?: string }): void;
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
  /** Texts the human about every chain of this task that has no alert yet (once the agent's session is over). */
  alertChains(task_id: TaskId): Promise<void>;
  /** Merchant protocol messages and human decisions are applied by this. */
  undo: UndoExecutor;
  /** Texts the human outside any chain (the alert channel; recorded but not sent without HUMAN_PHONE). */
  sayToHuman(task_id: TaskId, body: string): Promise<void>;
  /** The human's words disagree with the logged intent: ask "Reply 1 or 2" and remember the question. */
  askAboutIntent(task_id: TaskId, check: IntentCheck): Promise<void>;
  /** Where the intent question for this task stands, if one was asked. */
  intentCheckFor(task_id: TaskId): { status: "disagrees" | "confirmed_human" | "confirmed_agent"; check: IntentCheck } | null;
  /** The human answered 1 (their words) or 2 (the agent's). False when no question is open. */
  answerIntent(choice: 1 | 2): Promise<boolean>;
  /** RESUME after STOP: lifts the freeze and carries on with paused work. */
  resume(): Promise<void>;
  /** Answer to "Just to check..." after a correction text. False when no correction was waiting. */
  confirmCorrection(chain_id: ChainId, accept: boolean): Promise<boolean>;
  /** Demo only: closes open chains of earlier demo runs as expired, so nothing waits on them. */
  expireOtherDemoChains(current: TaskId): Promise<number>;
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
  const feed = deps.feed ?? createFeed();
  const note: Proxy["note"] = (entry) => feed.add({ ...entry, at: entry.at ?? clock.now() });
  const fedActions = new Set<string>();
  const when = (d: Action["dates"]) => (d ? `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "no date");
  const merchantName = (id: string) => deps.merchants.get(id)?.name ?? id;

  // One writer at a time per chain (alerts, plan, state); steps go to their own table.
  const chainQueues = new Map<ChainId, Promise<unknown>>();
  function lockChain<T>(chain_id: ChainId, fn: () => Promise<T>): Promise<T> {
    const run = (chainQueues.get(chain_id) ?? Promise.resolve()).then(fn, fn);
    chainQueues.set(chain_id, run.catch(() => undefined));
    return run;
  }
  const undo = createUndoExecutor({
    paymentsName: deps.paymentsName,
    lockChain,
    note,
    onReversed: async (chain_id) => {
      const chain = await store.getChain(chain_id);
      if (chain && deps.onRedoRequested) await deps.onRedoRequested(chain);
    },
    store,
    logic,
    inkbox: deps.inkbox,
    payments: deps.payments,
    merchants: deps.merchants,
    clock,
    params: deps.params,
    transport: deps.transport,
    proxyEmail: deps.proxyEmail,
    isFrozen: () => frozen,
    textHuman: (chain_id, kind, body) => textHuman(chain_id, kind, body),
    askHumanAboutCounter: (chain_id, negotiation_id, body) => askHumanAboutCounter(chain_id, negotiation_id, body),
    logEvent: (row) => logEvent(row),
  });
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
    const existingChains = await store.listChains(task_id);
    const claimedExisting = new Set<ChainId>();
    const now = clock.now();

    const saved: Chain[] = [];
    for (const t of traced) {
      const exact = await store.getChain(t.chain_id);
      const existing = exact ?? existingChains
        .filter((candidate) => !claimedExisting.has(candidate.chain_id))
        .map((candidate) => ({
          candidate,
          overlap: candidate.action_ids.filter((id) => t.action_ids.includes(id)).length,
        }))
        .filter(({ overlap }) => overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)[0]?.candidate;
      if (existing) claimedExisting.add(existing.chain_id);
      // The tightest window across the chain's actions.
      const windows = t.action_ids
        .map((id) => byId.get(id))
        .filter((a): a is Action => a !== undefined)
        .map((a) => logic.reversibility(a, now).window_ends_at)
        .filter((w): w is string => w !== null)
        .sort();
      const chain: Chain = {
        ...t,
        // trace derives ids from the root. A late booked action can replace a message root, but callers
        // and alerts must keep referring to the chain id that was already published.
        chain_id: existing?.chain_id ?? t.chain_id,
        // A booked root stays the root once settled (trace leaves refunded actions out, so it would pick the
        // message next); only a message root gives way to a booked action.
        root_action_id: existing && byId.get(existing.root_action_id)?.category !== "message" ? existing.root_action_id : t.root_action_id,
        // Actions that were already in the chain stay in it once settled (trace leaves refunded ones out),
        // so the live view keeps their green rows.
        action_ids: [...new Set([...(existing?.action_ids ?? []), ...t.action_ids])],
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
    const channel = deps.humanChannel ?? "imessage";
    note({ task_id: chain.task_id, chain_id, actor: "proxy", kind: "text_out", text: body, data: { channel, alert: kind } });
    // Without HUMAN_PHONE the alert is still recorded on the chain (the demo page shows it and its buttons reply).
    if (deps.canTextHuman !== false && deps.humanNumber) {
      await deps.inkbox.sendText(channel, deps.humanNumber, body);
      await logEvent({ kind: channel === "imessage" ? "imessage_out" : "sms_out", chain_id, task_id: chain.task_id, outcome: kind });
    } else {
      await logEvent({ kind: channel === "imessage" ? "imessage_out" : "sms_out", chain_id, task_id: chain.task_id, outcome: `${kind}:not_sent_no_human_number` });
    }
    await lockChain(chain_id, async () => {
      const alert: Alert = { channel, kind, body, sent_at: await alertTime() };
      const latest = (await store.getChain(chain_id)) ?? chain;
      await store.upsertChain({
        ...latest,
        alerts: [...latest.alerts, alert],
        state: latest.state === "detected" && kind === "chain_opened" ? "alerted" : latest.state,
      });
    });
  }

  // Alert times only move forward. A demo reset sets the simulated clock back, and replies go to the chain
  // with the latest alert, so a new run's alert must never look older than an earlier run's.
  let lastAlertMs: number | null = null;
  async function alertTime(): Promise<string> {
    if (lastAlertMs === null) {
      lastAlertMs = 0;
      for (const c of await store.listChains()) for (const a of c.alerts) lastAlertMs = Math.max(lastAlertMs, Date.parse(a.sent_at));
    }
    lastAlertMs = Math.max(clock.nowMs(), lastAlertMs + 1);
    return new Date(lastAlertMs).toISOString();
  }

  const alertTimers = new Map<TaskId, ReturnType<typeof setTimeout>>();

  async function alertChains(task_id: TaskId) {
    if (deps.sessions.isActive(task_id)) return;
    const { mismatches, chains } = await refreshChains(task_id);
    for (const chain of chains) {
      if (chain.state !== "detected" || chain.alerts.length > 0) continue;
      const mine = mismatches.filter((m) => chain.action_ids.includes(m.action_id));
      const actions = await store.listActions(task_id);
      const { at_risk, total } = chainMoney(chain, actions);
      const left = chain.window_ends_at ? Date.parse(chain.window_ends_at) - clock.nowMs() : null;
      await textHuman(chain.chain_id, "chain_opened", chainAlert({
        already: undoneByAgent(chain, actions),
        mismatch: mine[0],
        affected: chain.action_ids.filter((id) => actions.find((a) => a.action_id === id && !["verified", "kept"].includes(a.state))).length,
        at_risk,
        total,
        time_left_ms: left,
      }));
    }
  }

  function scheduleAlert(task_id: TaskId) {
    const ms = deps.alertSettleMs ?? 1500;
    clearTimeout(alertTimers.get(task_id));
    const t = setTimeout(() => {
      alertTimers.delete(task_id);
      alertChains(task_id).catch((e) => console.error("[alert] failed:", e));
    }, ms);
    t.unref?.();
    alertTimers.set(task_id, t);
  }

  async function taskIntent(chain_id: ChainId) {
    const chain = await store.getChain(chain_id);
    return chain ? store.getIntent(chain.task_id) : null;
  }

  /** The human confirmed (or not) a correction they texted. YES fixes the intent's dates if needed, then undoes the chain. */
  async function confirmCorrection(chain_id: ChainId, accept: boolean) {
    const pending = pendingCorrections.get(chain_id);
    if (!pending) return false;
    pendingCorrections.delete(chain_id);
    await logEvent({ kind: "sms_in", chain_id, outcome: accept ? "correction_confirmed" : "correction_declined" });
    if (!accept) {
      await textHuman(chain_id, "reminder", "Okay, nothing changed. Reply UNDO ALL, PICK or KEEP.");
      return true;
    }
    const intent = await taskIntent(chain_id);
    const dates = intent ? correctedDates(pending.corrected_text, intent) : null;
    if (intent && dates && (dates.start !== intent.constraints.dates?.start || dates.end !== intent.constraints.dates?.end)) {
      try {
        await updateIntent(intent.task_id, (i) => ({ ...i, constraints: { ...i.constraints, dates } }));
      } catch (e) {
        console.error("[correction] could not update the intent:", e instanceof Error ? e.name : e);
      }
    }
    await textHuman(chain_id, "reminder", `Got it${dates ? `: ${humanDate(dates.start)}` : ""}. Starting the undo.`);
    await undo.start(chain_id);
    return true;
  }

  /** The chain is redone once every rebooked category has a new booking that matches the intent. */
  async function checkRedone(chain: Chain, mismatches: Mismatch[]) {
    const intent = await store.getIntent(chain.task_id);
    if (!intent) return;
    const inChain = new Set(chain.action_ids);
    const old = (await Promise.all(chain.action_ids.map((id) => store.getAction(id)))).filter((a): a is Action => a !== null);
    const needed = [...new Set(old.filter((a) => a.category !== "message").map((a) => a.category))];
    const fresh = (await store.listActions(chain.task_id)).filter((a) => !inChain.has(a.action_id) && !mismatches.some((m) => m.action_id === a.action_id));
    if (!needed.every((cat) => fresh.some((a) => a.category === cat))) return;
    const latest = await lockChain(chain.chain_id, async () => {
      const c = await store.getChain(chain.chain_id);
      if (!c || c.state !== "redo_requested") return null;
      return store.upsertChain({ ...c, state: "redone" });
    });
    if (!latest) return;
    const d = intent.constraints.dates;
    const order = ["flight", "hotel", "transfer", "saas", "store"];
    const list = fresh
      .filter((a) => needed.includes(a.category))
      .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
      .map((a) => `${a.category} ${money(a.amount)}`)
      .join(", ");
    // An order has no dates: the redo is the right item.
    if (needed.length === 1 && needed[0] === "store") {
      const order = fresh.find((a) => a.category === "store")!;
      note({ task_id: chain.task_id, chain_id: chain.chain_id, actor: "proxy", kind: "chain", text: `Proxy: redo checked against the intent. ${order.summary}, ${money(order.amount)}.`, data: { state: "redone" } });
      await textHuman(chain.chain_id, "result", `Ordered the right one: ${order.summary}, ${money(order.amount)}. It matches what you asked for.`);
      return;
    }
    // A subscription has no dates: the redo is the right billing term.
    if (needed.length === 1 && needed[0] === "saas") {
      const plan = fresh.find((a) => a.category === "saas")!;
      note({ task_id: chain.task_id, chain_id: chain.chain_id, actor: "proxy", kind: "chain", text: `Proxy: redo checked against the intent. ${plan.summary}, ${money(plan.amount)}.`, data: { state: "redone" } });
      await textHuman(chain.chain_id, "result", `Re-subscribed: ${plan.summary}, ${money(plan.amount)}. It matches what you asked for.`);
      return;
    }
    note({ task_id: chain.task_id, chain_id: chain.chain_id, actor: "proxy", kind: "chain", text: `Proxy: redo checked against the intent. ${list}, all for ${d ? humanDate(d.start) : "the right dates"}.`, data: { state: "redone" } });
    await textHuman(chain.chain_id, "result", `Rebooked for ${d ? `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "the right dates"}: ${list}. Each confirmation matches what you asked for.`);
  }

  async function sayToHuman(task_id: TaskId, body: string) {
    const channel = deps.humanChannel ?? "imessage";
    note({ task_id, chain_id: null, actor: "proxy", kind: "text_out", text: body, data: { channel } });
    if (deps.canTextHuman !== false && deps.humanNumber) {
      await deps.inkbox.sendText(channel, deps.humanNumber, body);
      await logEvent({ kind: channel === "imessage" ? "imessage_out" : "sms_out", task_id, outcome: "intent_question" });
    } else {
      await logEvent({ kind: channel === "imessage" ? "imessage_out" : "sms_out", task_id, outcome: "intent_question:not_sent_no_human_number" });
    }
  }

  /** Intent questions by task, in the order they were asked. */
  const intentChecks = new Map<TaskId, { status: "disagrees" | "confirmed_human" | "confirmed_agent"; check: IntentCheck }>();

  async function updateIntent(task_id: TaskId, change: (i: Intent) => Intent) {
    const intent = await store.getIntent(task_id);
    if (!intent) return;
    const next = change(intent);
    const updater = (store as Partial<IntentUpdates>).updateIntent;
    if (updater) await updater.call(store, next);
    else await store.putIntent(next, `update:${task_id}:${clock.nowMs()}`);
    await refreshChains(task_id);
  }

  async function askHumanAboutCounter(chain_id: ChainId, negotiation_id: string, body: string) {
    // Tell the channel first, so a fast reply can't arrive before it knows what YES/NO means.
    humanChannel?.expectCounterDecision(chain_id, negotiation_id);
    await textHuman(chain_id, "reminder", body);
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
    feed,
    note,
    refreshChains,
    mostRecentlyAlertedOpenChain,
    startDemoTask,
    textHuman,
    alertChains,
    undo,
    confirmCorrection,
    sayToHuman,
    async askAboutIntent(task_id, check) {
      intentChecks.set(task_id, { status: "disagrees", check });
      note({ task_id, chain_id: null, actor: "proxy", kind: "mismatch", text: `Proxy: the agent's intent differs from the human's words (${check.understood} vs ${check.said}).`, data: { understood: check.understood ?? null, said: check.said ?? null } });
      await sayToHuman(task_id, intentQuestion(check));
    },
    intentCheckFor: (task_id) => intentChecks.get(task_id) ?? null,
    async answerIntent(choice) {
      const open = [...intentChecks.entries()].filter(([, v]) => v.status === "disagrees").at(-1);
      if (!open) return false;
      const [task_id, entry] = open;
      await logEvent({ kind: "sms_in", task_id, outcome: `intent_answer:${choice}` });
      // Reply 1 is the human's words, 2 the agent's; for an ambiguous date, 1 and 2 are its two readings.
      const answer = intentAnswer(entry.check, choice);
      if (answer.corrected) {
        await updateIntent(task_id, (i) => ({ ...i, constraints: { ...i.constraints, ...answer.corrected } }));
        intentChecks.set(task_id, { status: "confirmed_human", check: { ...entry.check, said: answer.said } });
        await sayToHuman(task_id, `Got it: ${answer.said}. Your agent will use that.`);
      } else {
        intentChecks.set(task_id, { ...entry, status: "confirmed_agent" });
        await sayToHuman(task_id, `Okay, keeping ${entry.check.understood}.`);
      }
      return true;
    },
    async resume() {
      if (!frozen) return;
      frozen = false;
      await logEvent({ kind: "sms_in", outcome: "resume" });
      await undo.resume();
    },
    async expireOtherDemoChains(current) {
      const demo = deps.demo;
      if (!demo) return 0;
      let n = 0;
      for (const c of await store.listChains()) {
        if (c.task_id === current || !c.task_id.startsWith(demo.identityTaskId) || !OPEN_STATES.has(c.state)) continue;
        await store.upsertChain({ ...c, state: "expired" });
        n += 1;
      }
      return n;
    },
    setHumanChannel(channel) {
      humanChannel = channel;
    },
    askHumanAboutCounter,
    logEvent,
    isFrozen: () => frozen,
    pendingCorrections,

    async onAction(action) {
      // Deduplicate by ref within the task: a repeated confirmation updates the same action.
      const same = (await store.listActions(action.task_id)).find((a) => a.ref === action.ref && a.ref !== "");
      const saved = await store.upsertAction(same ? { ...action, action_id: same.action_id, state: same.state } : action);
      await logEvent({ kind: action.source === "agent" ? "email_out" : "email_in", task_id: saved.task_id, action_id: saved.action_id });
      const redoing = (await store.listChains(saved.task_id)).find((c) => c.state === "redo_requested");
      // Capture may store the action before calling this hook, so "new" means new to the feed.
      if (!fedActions.has(saved.action_id)) {
        fedActions.add(saved.action_id);
        const data = { action_id: saved.action_id, merchant: saved.merchant, category: saved.category, amount: saved.amount, start: saved.dates?.start ?? null, end: saved.dates?.end ?? null, ref: saved.ref, ...(saved.category === "store" ? { item: saved.summary } : {}) };
        if (saved.category === "message") {
          note({ task_id: saved.task_id, chain_id: null, actor: "agent", kind: "message", text: `Agent emailed ${merchantName(saved.merchant)}: arriving ${when(saved.dates)}.`, data });
        } else {
          note({
            task_id: saved.task_id,
            chain_id: redoing?.chain_id ?? null,
            actor: "agent",
            kind: redoing ? "redo" : "booking",
            text:
              saved.category === "saas"
                ? `Agent ${redoing ? "re-subscribed" : "signed up"} with ${merchantName(saved.merchant)}: ${saved.summary}, ${money(saved.amount)}. Confirmation reached the task inbox.`
                : saved.category === "store"
                ? `Agent ${redoing ? "reordered" : "ordered"} from ${merchantName(saved.merchant)}: ${saved.summary}, ${money(saved.amount)}. Confirmation reached the task inbox.`
                : `Agent ${redoing ? "rebooked" : "booked"} the ${saved.category} with ${merchantName(saved.merchant)} for ${when(saved.dates)}, ${money(saved.amount)}. Confirmation reached the task inbox.`,
            data,
          });
        }
      }
      const { mismatches } = await refreshChains(saved.task_id);
      if (redoing) await checkRedone(redoing, mismatches);
      else scheduleAlert(saved.task_id);
    },

    async onStripeEvent(event) {
      await logEvent({ kind: "stripe_event", task_id: event.task_id, outcome: event.kind });
    },

    async onHumanReply(incoming) {
      // A reply that names no open chain belongs to the most recently alerted open chain.
      let reply = incoming;
      if (reply.kind !== "stop") {
        const named = await store.getChain(reply.chain_id);
        // In the demo, a reply always belongs to the current run, never to a chain left from an earlier one.
        const otherRun = Boolean(deps.demo?.current && named && named.task_id !== deps.demo.current);
        if (!named || !OPEN_STATES.has(named.state) || otherRun) {
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
      // Any later reply from the human lifts a STOP, and work paused by it carries on.
      if (frozen) {
        frozen = false;
        await undo.resume();
      }
      if (reply.kind === "correction") {
        // Confirmed once with the human before acting on it.
        pendingCorrections.set(reply.chain_id, { corrected_text: reply.corrected_text, received_at: reply.received_at });
        const intent = await taskIntent(reply.chain_id);
        const dates = intent ? correctedDates(reply.corrected_text, intent) : null;
        await textHuman(
          reply.chain_id,
          "reminder",
          dates
            ? `Just to check: the right dates are ${humanDate(dates.start)}${dates.end ? ` to ${humanDate(dates.end)}` : ""}? Reply YES to fix everything for those dates, or NO.`
            : `Just to check: you want this fixed? Reply YES to undo it, or NO.`,
        );
        return;
      }
      // The undo runs after this returns, so the channel's "Got it" reaches the human before any progress text.
      const later = (work: () => Promise<void>) =>
        setImmediate(() => work().catch((e) => console.error("[undo] failed:", e)));
      if (reply.kind === "undo_all") later(() => undo.start(reply.chain_id));
      else if (reply.kind === "pick") later(() => undo.start(reply.chain_id, reply.picks));
      else if (reply.kind === "keep") await undo.keep(reply.chain_id);
      else if (reply.kind === "counter_decision")
        later(() => undo.decideCounter(reply.chain_id, reply.negotiation_id, { accept: reply.accept, ...(reply.choice !== undefined ? { choice: reply.choice } : {}), ...(reply.push ? { push: true } : {}) }));
    },

    async onProtocolMessage(message) {
      // Only typed fields are logged; free text (e.g. DenyMsg.reason) is never acted on.
      await logEvent({ kind: "a2a", chain_id: message.chain_id, action_id: message.action_id, outcome: message.type });
      await undo.onProtocolMessage(message);
    },
  };
}
