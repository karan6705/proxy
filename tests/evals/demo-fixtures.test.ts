import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_INTENT,
  DEMO_LOG_INTENT,
  DEMO_TASK_EMAIL,
  buildDemoFixtures,
  demoFixtureFiles,
} from "../../evals/demo-fixtures.js";
import { parseJsonLd } from "../../evals/sim.js";
import { compare, planUndo, trace } from "../../src/logic/index.js";
import type { Action } from "../../src/types.js";
import { DEMO_NOW } from "../helpers/demo.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "demo");

function filesOnDisk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesOnDisk(full) : [relative(FIXTURE_DIR, full)];
  });
}

const byId = (actions: Action[], id: string): Action => actions.find((a) => a.action_id === id) as Action;

describe("demo fixtures: the files on disk", () => {
  it("are exactly what the generator produces now (run `npx tsx evals/demo-fixtures.ts` if this fails)", async () => {
    const expected = await demoFixtureFiles();
    const onDisk = filesOnDisk(FIXTURE_DIR).filter((path) => path !== "README.md").sort();
    expect(onDisk).toEqual(Object.keys(expected).sort());
    for (const [path, content] of Object.entries(expected)) {
      expect(readFileSync(join(FIXTURE_DIR, path), "utf8"), path).toBe(content);
    }
  });
});

describe("demo fixtures: the wrong bookings (Nov 3 instead of Nov 13)", async () => {
  const { wrong } = await buildDemoFixtures();

  it("are the flight, hotel, transfer and host email, worth $1,240", () => {
    expect(wrong.actions.map((a) => a.category).sort()).toEqual(["flight", "hotel", "message", "transfer"]);
    expect(wrong.actions.reduce((sum, a) => sum + a.amount, 0)).toBe(124000);
  });

  it("carry the merchants' real references and the right dates", () => {
    expect(byId(wrong.actions, "act_flight")).toMatchObject({ amount: 41200, dates: { start: "2026-11-03" }, merchant: "airline" });
    expect(byId(wrong.actions, "act_hotel")).toMatchObject({ amount: 64000, dates: { start: "2026-11-03", end: "2026-11-06" }, merchant: "hotel" });
    expect(byId(wrong.actions, "act_transfer")).toMatchObject({ amount: 18800, dates: { start: "2026-11-03" }, merchant: "transfer" });
    expect(byId(wrong.actions, "act_host_email")).toMatchObject({ amount: 0, dates: { start: "2026-11-03" }, source: "agent" });
    expect(byId(wrong.actions, "act_flight").ref).toMatch(/^AIR-[A-Z0-9]{6}$/);
    expect(byId(wrong.actions, "act_hotel").ref).toMatch(/^HTL-[A-Z0-9]{6}$/);
    expect(byId(wrong.actions, "act_transfer").ref).toMatch(/^TRF-[A-Z0-9]{6}$/);
    expect(byId(wrong.actions, "act_host_email").ref).toMatch(/^MSG-[A-Z0-9]{6}$/);
  });

  it("have the demo timeline, with the hotel confirmation arriving late, after the agent has left", () => {
    expect(byId(wrong.actions, "act_flight").received_at).toBe("2026-10-17T09:05:00.000Z");
    expect(byId(wrong.actions, "act_transfer").received_at).toBe("2026-10-17T09:20:00.000Z");
    expect(byId(wrong.actions, "act_host_email").received_at).toBe("2026-10-17T09:30:00.000Z");
    expect(byId(wrong.actions, "act_hotel").received_at).toBe("2026-10-17T11:05:00.000Z");
  });

  it("come with a confirmation email each, to the task address, with schema.org markup", () => {
    const types: Record<string, string> = {
      flight: "FlightReservation",
      hotel: "LodgingReservation",
      transfer: "TaxiReservation",
      host_email: "EmailMessage",
    };
    expect(wrong.emails.map((e) => e.id).sort()).toEqual(Object.keys(types).sort());
    for (const { id, email } of wrong.emails) {
      expect(email.to).toBe(DEMO_TASK_EMAIL);
      expect(parseJsonLd(email.html)["@type"]).toBe(types[id]);
      expect(parseJsonLd(email.html)["@context"]).toBe("https://schema.org");
      expect(email.body.length).toBeGreaterThan(50);
    }
  });

  it("have a Stripe charge for each paid booking, and none for the free message", () => {
    expect(wrong.stripe_events.map((e) => [e.merchant, e.amount, e.kind])).toEqual([
      ["airline", 41200, "charge.succeeded"],
      ["hotel", 64000, "charge.succeeded"],
      ["transfer", 18800, "charge.succeeded"],
    ]);
    expect(wrong.stripe_events.every((e) => e.task_id === "task_nyc" && e.refunded_amount === 0)).toBe(true);
  });
});

describe("demo fixtures: they work with the logic", async () => {
  const { wrong, correct } = await buildDemoFixtures();

  it("compare finds the Nov 3 dates on all four wrong bookings", () => {
    const mismatches = compare(DEMO_INTENT, wrong.actions);
    expect(mismatches.map((m) => `${m.action_id}:${m.field}`).sort()).toEqual([
      "act_flight:dates",
      "act_host_email:dates",
      "act_hotel:dates",
      "act_transfer:dates",
    ]);
    expect(mismatches.every((m) => m.actual === "2026-11-03" && m.expected === "2026-11-13")).toBe(true);
  });

  it("trace makes one chain of four rooted at the flight, with $1,240 at risk", () => {
    const [chain, ...rest] = trace(DEMO_INTENT, wrong.actions, compare(DEMO_INTENT, wrong.actions));
    expect(rest).toEqual([]);
    expect(chain).toMatchObject({ root_action_id: "act_flight", money_at_risk: 124000, window_ends_at: "2026-10-18T09:05:00.000Z" });
    expect(chain.action_ids).toHaveLength(4);
  });

  it("plan_undo gives the demo plan: flight self-serve, hotel protocol, transfer email, host correction", () => {
    const [chain] = trace(DEMO_INTENT, wrong.actions, compare(DEMO_INTENT, wrong.actions));
    const plan = planUndo(chain, wrong.actions, DEMO_INTENT.preferences, DEMO_NOW);
    expect(plan.map((s) => [s.action_id, s.route])).toEqual([
      ["act_flight", "self_serve"],
      ["act_hotel", "reversal_protocol"],
      ["act_transfer", "email_support"],
      ["act_host_email", "correction"],
    ]);
  });

  it("the corrected bookings for Nov 13 match the intent, so the redo is clean", () => {
    expect(compare(DEMO_INTENT, correct.actions)).toEqual([]);
    expect(correct.actions.reduce((sum, a) => sum + a.amount, 0)).toBe(124000);
  });

  it("the intent is the same as the log_intent input", () => {
    expect(DEMO_INTENT.goal).toBe(DEMO_LOG_INTENT.goal);
    expect(DEMO_INTENT.constraints).toEqual(DEMO_LOG_INTENT.constraints);
  });
});
