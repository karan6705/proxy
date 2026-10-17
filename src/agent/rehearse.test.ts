import { describe, expect, it, vi } from "vitest";
import { createOfflineDemoControl, createOfflineToolClient } from "./offline.js";
import { createMockAgentPayments } from "./payments.js";
import { runRehearsal } from "./rehearse.js";
import { createDemoClock, SCRIPTED_DEMO_STEPS } from "./scripted.js";

function tickingClock(step = 10): () => number {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

describe("demo rehearsal", () => {
  it("prints PASS for every step and the total", async () => {
    const lines: string[] = [];
    const result = await runRehearsal({
      offline: true,
      client: createOfflineToolClient(),
      control: createOfflineDemoControl(),
      payments: createMockAgentPayments(),
      clock: createDemoClock(),
      reset: vi.fn(async () => undefined),
      now: tickingClock(),
      write: (line) => lines.push(line),
    });

    expect(result.passed).toBe(true);
    expect(result.steps.map((item) => item.step)).toEqual(["reset", "connect", ...SCRIPTED_DEMO_STEPS]);
    expect(result.steps.every((item) => item.status === "PASS")).toBe(true);
    expect(lines).toHaveLength(result.steps.length + 1);
    expect(lines.every((line) => line.startsWith("PASS"))).toBe(true);
  });

  it("prints FAIL for a failed and every unrun step", async () => {
    const lines: string[] = [];
    const result = await runRehearsal({
      offline: true,
      reset: async () => {
        throw new Error("reset unavailable");
      },
      now: tickingClock(),
      write: (line) => lines.push(line),
    });

    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(2 + SCRIPTED_DEMO_STEPS.length);
    expect(lines[0]).toMatch(/^FAIL reset/);
    expect(lines.at(-1)).toMatch(/^FAIL total/);
  });
});
