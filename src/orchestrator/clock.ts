// The only source of time. Demos and evals use the simulated clock with seeded times.
import type { Clock, SimulatedClock, Timestamp } from "../types.js";

export function createRealClock(): Clock {
  return {
    mode: "real",
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/**
 * Starts at `start` and moves only when set() or advance() is called, plus `scale` simulated ms
 * per real ms when scale > 0 (CLOCK_SCALE). Scale 0, the default, is fully manual for tests.
 */
export function createSimulatedClock(start: Timestamp, scale = 0): SimulatedClock {
  let baseSim = Date.parse(start);
  let baseReal = Date.now();
  if (Number.isNaN(baseSim)) throw new Error(`Invalid start time: ${start}`);
  const nowMs = () => baseSim + (Date.now() - baseReal) * scale;
  return {
    mode: "simulated",
    nowMs,
    now: () => new Date(nowMs()).toISOString(),
    set(t) {
      const ms = Date.parse(t);
      if (Number.isNaN(ms)) throw new Error(`Invalid time: ${t}`);
      baseSim = ms;
      baseReal = Date.now();
    },
    advance(ms) {
      baseSim = nowMs() + ms;
      baseReal = Date.now();
    },
  };
}
