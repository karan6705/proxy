// Polls Inkbox politely. Inkbox allows 600 requests a minute per key and answers 429 with retry_after_seconds;
// one poll can page through many messages, so a fixed timer can keep hitting the limit and starve the key.
//   - guardAccess wraps an identity's access: a 429 starts a cooldown, and every call during it fails at once
//     without touching the network (so the rest of that poll stops too).
//   - schedulePolls runs pollOnce at most every minIntervalMs, waits out the cooldown, and backs off
//     exponentially while 429s continue.
//   - throttledLog lets at most one line a minute through, counting what it held back.
import type { A2AAccess } from "../inkbox/index.js";

export interface RateLimitState {
  /** Epoch ms before which no Inkbox call is made. 0 when not limited. */
  until: number;
  /** 429s in a row; reset by a poll without one. */
  strikes: number;
  /** Set by a 429 since the last poll finished. */
  hit: boolean;
}

/** Seconds to wait for a 429 error from the Inkbox SDK, or null if the error is not a rate limit. */
export function retryAfterOf(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown; retryAfterSeconds?: unknown; detail?: unknown };
  if (e?.statusCode !== 429 && e?.status !== 429) return null;
  if (typeof e.retryAfterSeconds === "number" && e.retryAfterSeconds > 0) return e.retryAfterSeconds;
  const fromBody = (e.detail as { retry_after_seconds?: unknown } | undefined)?.retry_after_seconds;
  return typeof fromBody === "number" && fromBody > 0 ? fromBody : 0;
}

export class RateLimitedError extends Error {
  constructor(readonly untilMs: number) {
    super("Inkbox rate limit: waiting before the next call");
    this.name = "RateLimitedError";
  }
}

export function createRateLimitState(): RateLimitState {
  return { until: 0, strikes: 0, hit: false };
}

/** Wraps an object's methods (and the async iterators they return) so a 429 starts a cooldown. */
function guardObject<T extends object>(target: T, state: RateLimitState, now: () => number): T {
  const onError = (error: unknown) => {
    const seconds = retryAfterOf(error);
    if (seconds !== null) {
      state.hit = true;
      state.until = Math.max(state.until, now() + seconds * 1000);
    }
    throw error;
  };
  const check = () => {
    if (now() < state.until) throw new RateLimitedError(state.until);
  };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        check();
        let result: unknown;
        try {
          result = value.apply(obj, args);
        } catch (e) {
          return onError(e);
        }
        if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function" && typeof (result as Promise<unknown>).then !== "function") {
          const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              check();
              try {
                return await it.next();
              } catch (e) {
                return onError(e);
              }
            },
            async return(v?: unknown) {
              return (await it.return?.(v)) ?? { done: true, value: v };
            },
          };
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => (v && typeof v === "object" ? guardObject(v as object, state, now) : v),
            onError,
          );
        }
        return result;
      };
    },
  });
}

/** The identity (and anything it returns) goes through the cooldown. */
export function guardAccess(access: A2AAccess, state: RateLimitState, now: () => number = Date.now): A2AAccess {
  return {
    async identity() {
      if (now() < state.until) throw new RateLimitedError(state.until);
      const { inkbox, identity } = await access.identity();
      return { inkbox: guardObject(inkbox, state, now), identity: guardObject(identity, state, now) };
    },
  };
}

export interface PollSchedule {
  stop(): void;
  /** The delay chosen after the last poll, for logs and tests. */
  lastDelayMs(): number;
}

export interface ScheduleOptions {
  pollOnce: () => Promise<unknown>;
  state: RateLimitState;
  minIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Runs pollOnce one at a time, at most every minIntervalMs, waiting out 429 cooldowns with exponential backoff. */
export function schedulePolls(opts: ScheduleOptions): PollSchedule {
  const min = opts.minIntervalMs ?? 3000;
  const max = opts.maxBackoffMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const { state } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let last = min;

  const next = (delay: number) => {
    if (stopped) return;
    last = delay;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  async function tick() {
    if (now() < state.until) return next(state.until - now());
    state.hit = false;
    try {
      await opts.pollOnce();
    } catch (e) {
      if (!(e instanceof RateLimitedError) && retryAfterOf(e) === null) opts.log?.(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (state.hit) {
      state.strikes += 1;
      const backoff = Math.min(max, min * 2 ** state.strikes);
      const wait = Math.max(backoff, state.until - now());
      state.until = now() + wait;
      opts.log?.(`Inkbox rate limit (429): pausing polls for ${Math.round(wait / 1000)} s`);
      return next(wait);
    }
    state.strikes = 0;
    next(min);
  }

  next(0);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    lastDelayMs: () => last,
  };
}

/** At most one line per window; held-back lines are counted in the next one. */
export function throttledLog(write: (line: string) => void, windowMs = 60_000, now: () => number = Date.now): (line: string) => void {
  let lastAt = -Infinity;
  let held = 0;
  return (line) => {
    if (now() - lastAt < windowMs) {
      held += 1;
      return;
    }
    lastAt = now();
    write(held ? `${line} (+${held} similar in the last minute)` : line);
    held = 0;
  };
}
