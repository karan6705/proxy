import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimitState, guardAccess, retryAfterOf, schedulePolls, throttledLog } from "./poll-guard.js";
import { startProtocolInbox, type Runtime } from "./runtime.js";
import { createSimulatedClock } from "./clock.js";

/** An Inkbox SDK 429, as InkboxAPIError carries it. */
const tooMany = (seconds: number | null, inBody = false) =>
  Object.assign(new Error("Too many requests"), { statusCode: 429, retryAfterSeconds: inBody ? null : seconds, detail: inBody ? { retry_after_seconds: seconds } : "rate limited" });

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("Inkbox polling under a rate limit", () => {
  it("reads retry_after_seconds from the error or its body", () => {
    expect(retryAfterOf(tooMany(12))).toBe(12);
    expect(retryAfterOf(tooMany(7, true))).toBe(7);
    expect(retryAfterOf(new Error("boom"))).toBeNull();
  });

  it("polls at most every 3 seconds when all is well", async () => {
    const state = createRateLimitState();
    let polls = 0;
    const s = schedulePolls({ pollOnce: async () => void polls++, state });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBeLessThanOrEqual(11);
    expect(polls).toBeGreaterThanOrEqual(10);
    s.stop();
  });

  it("honors retry_after_seconds, backs off exponentially, and makes no calls while waiting", async () => {
    const state = createRateLimitState();
    let networkCalls = 0;
    let limited = true;
    const identity = {
      async *iterA2AMessages() {
        networkCalls += 1;
        if (limited) throw tooMany(20);
        yield { id: "m1" };
      },
      async listEmails() {
        networkCalls += 1;
        return [];
      },
    };
    const access = guardAccess({ identity: async () => ({ inkbox: {} as never, identity: identity as never }) }, state);
    // Like the inbox: it catches its own errors and goes on to the email part.
    const pollOnce = async () => {
      const { identity: id } = await access.identity();
      try {
        for await (const m of (id as unknown as typeof identity).iterA2AMessages()) void m;
      } catch {
        /* the inbox logs and continues */
      }
      try {
        await (id as unknown as typeof identity).listEmails();
      } catch {
        /* skipped during the cooldown, without a network call */
      }
    };
    const lines: string[] = [];
    const s = schedulePolls({ pollOnce, state, log: (l) => lines.push(l) });

    await vi.advanceTimersByTimeAsync(0);
    expect(networkCalls).toBe(1); // the 429; the email call in the same poll never went out
    expect(state.until).toBe(20_000); // max(retry_after 20 s, 3 s x 2)

    await vi.advanceTimersByTimeAsync(19_000);
    expect(networkCalls).toBe(1); // nothing during the cooldown

    await vi.advanceTimersByTimeAsync(1_000); // second 429 at 20 s: backoff 3 s x 4 = 12 s < retry_after 20 s
    expect(networkCalls).toBe(2);
    expect(state.strikes).toBe(2);
    expect(s.lastDelayMs()).toBe(20_000);

    limited = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.strikes).toBe(0);
    expect(s.lastDelayMs()).toBe(3_000);
    expect(lines.filter((l) => l.includes("429"))).toHaveLength(2);
    s.stop();
  });

  it("backs off exponentially when the 429 has no retry_after", async () => {
    const state = createRateLimitState();
    const pollOnce = async () => {
      state.hit = true; // what the guard records for a bare 429
    };
    const s = schedulePolls({ pollOnce, state, maxBackoffMs: 60_000 });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(s.lastDelayMs());
      delays.push(s.lastDelayMs());
    }
    expect(delays).toEqual([6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);
    s.stop();
  });

  it("logs at most one line per minute", () => {
    const out: string[] = [];
    const log = throttledLog((l) => out.push(l));
    for (let i = 0; i < 50; i++) {
      log("a2a poll failed: 429");
      vi.advanceTimersByTime(1_000);
    }
    expect(out).toEqual(["a2a poll failed: 429"]);
    vi.advanceTimersByTime(20_000);
    log("again");
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("+49 similar");
  });

  it("never starts the poller in dry-run", async () => {
    const access = { identity: vi.fn() };
    const started = await startProtocolInbox(() => ({}) as Runtime, createSimulatedClock("2026-10-25T10:00:00.000Z"), { INKBOX_API_KEY: "x", INKBOX_DRY_RUN: "1", PROXY_PROTOCOL_LOOPBACK: "0" }, access);
    expect(started).toBeNull();
    expect(access.identity).not.toHaveBeenCalled();
  });
});
