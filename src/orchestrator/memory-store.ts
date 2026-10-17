// In-memory Store, used until Sarah's Supabase Store in src/db/ merges. Same interface, no persistence.
import type { Action, Chain, EventRow, EvidenceSeen, Intent, Lesson, Step, Store, TaskId } from "../types.js";

export interface MemoryStore extends Store {
  readonly events: readonly EventRow[];
}

const clone = <T>(v: T): T => structuredClone(v);

export function createMemoryStore(): MemoryStore {
  const intents = new Map<TaskId, Intent>();
  const intentByKey = new Map<string, TaskId>();
  const actions = new Map<string, Action>();
  const chains = new Map<string, Chain>();
  const lessons: Lesson[] = [];
  const events: EventRow[] = [];

  return {
    events,
    async putIntent(intent, idempotency_key) {
      intents.set(intent.task_id, clone(intent));
      intentByKey.set(idempotency_key, intent.task_id);
      return clone(intent);
    },
    async getIntent(task_id) {
      const i = intents.get(task_id);
      return i ? clone(i) : null;
    },
    async getIntentByIdempotencyKey(key) {
      const id = intentByKey.get(key);
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
      return c ? clone(c) : null;
    },
    async listChains(task_id) {
      return [...chains.values()].filter((c) => task_id === undefined || c.task_id === task_id).map(clone);
    },
    async upsertChain(chain) {
      chains.set(chain.chain_id, clone(chain));
      return clone(chain);
    },
    async appendStep(step: Step) {
      const c = chains.get(step.chain_id);
      if (c) c.steps.push(clone(step));
    },
    async listLessons() {
      return lessons.map(clone);
    },
    async addLesson(lesson) {
      lessons.push(clone(lesson));
    },
    async countEvidence(task_id): Promise<EvidenceSeen> {
      const mine = [...actions.values()].filter((a) => a.task_id === task_id);
      return {
        emails: mine.filter((a) => a.source === "email").length,
        stripe_events: mine.filter((a) => a.source === "stripe").length,
        actions: mine.length,
      };
    },
    async logEvent(row) {
      events.push(clone(row));
    },
  };
}
