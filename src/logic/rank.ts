// rank(chains, now): the undo queue order. score = money_at_risk / max(hours_left, MIN_HOURS), highest first.
//
// - A chain with no window scores 0 (nothing is running out).
// - A window that has already passed counts as hours_left <= 0, so the MIN_HOURS floor applies. It stays at the top
//   until the orchestrator marks the chain expired.
// - Chains whose money is already safe (reversed, redo_requested, redone, closed, kept, expired) go last.
// - Ties are broken by chain_id so the order is stable. The input array is not mutated.

import type { Chain, ChainState, Timestamp } from "../types.js";
import { MS_PER_HOUR, timestampToMs } from "./dates.js";
import { DEFAULT_MIN_HOURS } from "./rules.js";

const MONEY_SAFE_STATES: ReadonlySet<ChainState> = new Set([
  "reversed",
  "redo_requested",
  "redone",
  "closed",
  "kept",
  "expired",
]);

function score(chain: Chain, nowMs: number, minHours: number): number {
  if (chain.window_ends_at === null) {
    return 0;
  }
  const hoursLeft = (timestampToMs(chain.window_ends_at) - nowMs) / MS_PER_HOUR;
  return chain.money_at_risk / Math.max(hoursLeft, minHours);
}

export function rank(chains: Chain[], now: Timestamp, minHours: number = DEFAULT_MIN_HOURS): Chain[] {
  const nowMs = timestampToMs(now);
  return chains
    .map((chain) => ({ chain, safe: MONEY_SAFE_STATES.has(chain.state), score: score(chain, nowMs, minHours) }))
    .sort((a, b) => {
      if (a.safe !== b.safe) {
        return a.safe ? 1 : -1;
      }
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.chain.chain_id.localeCompare(b.chain.chain_id);
    })
    .map((entry) => entry.chain);
}
