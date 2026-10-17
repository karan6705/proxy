// In-memory agent sessions on the Clock. Moves to Store if sessions must survive a restart.
import type { Clock, Sessions, TaskId } from "../types.js";

export function createSessions(clock: Clock, idleMs: number): Sessions {
  const lastSeen = new Map<TaskId, number>();
  const ended = new Set<TaskId>();
  return {
    touch(task_id) {
      if (!ended.has(task_id)) lastSeen.set(task_id, clock.nowMs());
    },
    end(task_id) {
      ended.add(task_id);
    },
    isActive(task_id) {
      const seen = lastSeen.get(task_id);
      return !ended.has(task_id) && seen !== undefined && clock.nowMs() - seen <= idleMs;
    },
  };
}
