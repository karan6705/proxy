// Pure logic for Proxy. Everything time-dependent takes `now`, so it runs on the simulated clock.
// plan_undo and negotiate_step (the rest of the Logic interface) come next.

import type { Logic } from "../types.js";
import { compare } from "./compare.js";
import { rank } from "./rank.js";
import { reversibility } from "./reversibility.js";
import { trace } from "./trace.js";

export { compare } from "./compare.js";
export { rank } from "./rank.js";
export { reversibility, windowEndsAt } from "./reversibility.js";
export { trace } from "./trace.js";
export * from "./dates.js";
export * from "./rules.js";

export const logic: Pick<Logic, "compare" | "trace" | "reversibility" | "rank"> = {
  compare,
  trace,
  reversibility,
  rank,
};
