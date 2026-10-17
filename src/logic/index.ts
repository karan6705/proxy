// Pure logic for Proxy: the six functions of the Logic interface in types.ts.
// Everything time-dependent takes `now`, so it runs on the simulated clock. No network, database or clock reads.

import type { Logic } from "../types.js";
import { compare } from "./compare.js";
import { negotiateStep } from "./negotiate-step.js";
import { planUndo } from "./plan-undo.js";
import { rank } from "./rank.js";
import { reversibility } from "./reversibility.js";
import { trace } from "./trace.js";

export { compare } from "./compare.js";
export { MAX_PUSH_BACKS, MAX_ROUNDS, negotiateStep } from "./negotiate-step.js";
export type { IgnoredText, NegotiateStepOutcome } from "./negotiate-step.js";
export { planUndo } from "./plan-undo.js";
export { rank } from "./rank.js";
export { reversibility, windowEndsAt } from "./reversibility.js";
export { trace } from "./trace.js";
export * from "./dates.js";
export * from "./rules.js";

export const logic: Logic = {
  compare,
  trace,
  reversibility,
  plan_undo: planUndo,
  rank,
  negotiate_step: negotiateStep,
};
