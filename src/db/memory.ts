// In-memory Store for tests, evals and local runs. Same behaviour as the Supabase store.
import type {
  Action,
  ActionId,
  Chain,
  ChainId,
  EventRow,
  EvidenceSeen,
  Intent,
  Lesson,
  Step,
  Store,
  TaskId,
} from "../types.js";

export interface MemoryStore extends Store, EventReader {
  /** Read-only copy of the append-only log, for tests. */
  events(): readonly EventRow[];
}

/** Newest-first read of the append-only log, for the demo page. Not part of Store, which only writes events. */
export interface EventReader {
  recentEvents(limit: number): Promise<EventRow[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export function createMemoryStore(): MemoryStore {
  const intents = new Map<TaskId, Intent>();
  const intentKeys = new Map<string, TaskId>();
  const actions = new Map<ActionId, Action>();
  const chains = new Map<ChainId, Chain>();
  const steps: Step[] = [];
  const lessons = new Map<string, Lesson>();
  const log: EventRow[] = [];

  const withSteps = (chain: Chain): Chain => ({
    ...clone(chain),
    steps: steps.filter((s) => s.chain_id === chain.chain_id).map(clone),
  });

  return {
    async putIntent(intent, idempotency_key) {
      const existingId = intentKeys.get(idempotency_key);
      const existing = existingId ? intents.get(existingId) : undefined;
      if (existing) return clone(existing);
      intents.set(intent.task_id, clone(intent));
      intentKeys.set(idempotency_key, intent.task_id);
      return clone(intent);
    },
    async getIntent(task_id) {
      const i = intents.get(task_id);
      return i ? clone(i) : null;
    },
    async getIntentByIdempotencyKey(key) {
      const id = intentKeys.get(key);
      const i = id ? intents.get(id) : undefined;
      return i ? clone(i) : null;
    },
    async listActions(task_id) {
      return [...actions.values()].filter((a) => a.task_id === task_id).map(clone);
    },
    async getAction(action_id) {
      const a = actions.get(action_id);
      return a ? clone(a) : null;
    },
    async upsertAction(action) {
      actions.set(action.action_id, clone(action));
      return clone(action);
    },
    async getChain(chain_id) {
      const c = chains.get(chain_id);
      return c ? withSteps(c) : null;
    },
    async listChains(task_id) {
      return [...chains.values()].filter((c) => !task_id || c.task_id === task_id).map(withSteps);
    },
    async upsertChain(chain) {
      chains.set(chain.chain_id, clone({ ...chain, steps: [] }));
      return withSteps(chain);
    },
    async appendStep(step) {
      steps.push(clone(step));
    },
    async listLessons() {
      return [...lessons.values()].map(clone);
    },
    async addLesson(lesson) {
      // Keyed by mistake_code so a repeated mistake updates its lesson instead of duplicating it.
      lessons.set(lesson.mistake_code, clone(lesson));
    },
    async countEvidence(task_id): Promise<EvidenceSeen> {
      return {
        emails: log.filter((e) => e.task_id === task_id && e.kind === "email_in").length,
        stripe_events: log.filter((e) => e.task_id === task_id && e.kind === "stripe_event").length,
        actions: [...actions.values()].filter((a) => a.task_id === task_id).length,
      };
    },
    async logEvent(row) {
      log.push(Object.freeze(clone(row)));
    },
    events: () => log,
    async recentEvents(limit) {
      return log.slice(-limit).reverse().map(clone);
    },
  };
}
