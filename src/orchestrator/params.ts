// Default parameters. Values not yet agreed by the team are marked; change them only by team agreement.
import type { Params } from "../types.js";

const MINUTE = 60_000;

export const DEFAULT_PARAMS: Params = {
  MIN_HOURS: 1, // placeholder until agreed
  REPLY_WAIT: 10 * MINUTE, // placeholder until agreed
  CALL_AT: 0.8, // placeholder until agreed
  AUTO_UNDO_AT: 0.9, // placeholder until agreed
  FOLLOW_UP_EVERY: 30 * MINUTE, // placeholder until agreed
  PROTOCOL_DEADLINE: 60 * MINUTE, // placeholder until agreed
  CLOCK_SCALE: 0, // manual simulated clock; placeholder until agreed
  SESSION_IDLE_MS: 5 * MINUTE, // placeholder until agreed
  // From the demo: "no store credit, partial refunds over 80% are fine".
  DEFAULT_PREFERENCES: { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false },
};
