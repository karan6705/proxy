// Lets the orchestrator change a logged intent (a confirmed correction, or the human's answer to "Reply 1 or 2").
// The Store contract has no update yet (requested from Sarah): when the store has updateIntent it is used;
// otherwise the new intent is kept here, in memory, and getIntent returns it. Everything else passes through,
// including extras like recentEvents.
import type { Intent, Store, TaskId } from "../types.js";

export interface IntentUpdates {
  updateIntent(intent: Intent): Promise<void>;
}

export function withIntentUpdates<S extends Store>(store: S): S & IntentUpdates {
  const overrides = new Map<TaskId, Intent>();
  const native = (store as Partial<IntentUpdates>).updateIntent;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "updateIntent") {
        return async (intent: Intent) => {
          if (native) {
            try {
              await native.call(target, intent);
              overrides.delete(intent.task_id);
              return;
            } catch (e) {
              console.error("[intent] store update failed, keeping it in memory:", e instanceof Error ? e.name : e);
            }
          }
          overrides.set(intent.task_id, structuredClone(intent));
        };
      }
      if (prop === "getIntent") {
        return async (task_id: TaskId) => {
          const o = overrides.get(task_id);
          return o ? structuredClone(o) : target.getIntent(task_id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as S & IntentUpdates;
}
