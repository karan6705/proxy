import { describe, expect, it } from "vitest";
import { applyIntentCheck } from "../../evals/live/intent.js";
import { LIVE_TASKS } from "../../evals/live/tasks.js";

const logged = (start: string, end: string) => ({ goal: "trip", constraints: { dates: { start, end }, budget_total: 150000 } });
const request = (id: string): string => LIVE_TASKS.find((task) => task.id === id)?.request ?? "";

describe("the intent check from the human's own words, applied to a logged intent", () => {
  it("corrects the intent when the human's words name a different date (the simulated answer is their own words)", () => {
    const outcome = applyIntentCheck(logged("2026-11-03", "2026-11-06"), "Book it for November 13 to 16", 2026);
    expect(outcome).toMatchObject({ status: "disagrees", understood: expect.stringContaining("Nov 3"), said: expect.stringContaining("Nov 13") });
    expect(outcome.intent?.constraints.dates).toEqual({ start: "2026-11-13", end: "2026-11-16" });
    expect(outcome.intent?.constraints.budget_total).toBe(150000);
  });

  it("leaves the intent alone when it agrees, or when there are no words to compare", () => {
    const agrees = applyIntentCheck(logged("2026-11-13", "2026-11-16"), "Book it for November 13 to 16", 2026);
    expect(agrees.status).toBe("agrees");
    expect(agrees.intent?.constraints.dates).toEqual({ start: "2026-11-13", end: "2026-11-16" });
    expect(applyIntentCheck(logged("2026-11-03", "2026-11-06"), null, 2026).status).toBe("absent");
    expect(applyIntentCheck(null, "anything", 2026)).toEqual({ status: "absent", intent: null });
  });

  it("C1 states no date, so only its budget is checked and it agrees; C2's 3/11 reads two ways, so it disagrees and the other reading wins", () => {
    const c1 = applyIntentCheck(logged("2026-11-03", "2026-11-06"), request("C1"), 2026);
    const c2 = applyIntentCheck(logged("2027-03-11", "2027-03-14"), request("C2"), 2026);
    expect(c1.status).toBe("agrees");
    expect(c2).toMatchObject({ status: "disagrees", said: "3/11 (Mar 11 or Nov 3)" });
    expect(c2.intent?.constraints.dates).toEqual({ start: "2027-11-03", end: "2027-11-06" });
  });
});
