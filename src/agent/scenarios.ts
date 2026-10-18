// The buying agent's part of /web/show's other two stories, against a running server (npm run demo:go -- --scenario <name>).
//   ambiguous  The human writes "3/11". The agent logs Mar 11 with the human's own words; Proxy's intent check texts the
//              human before anything is booked; the agent waits for the answer (tap 1 or 2 on /web/show, or reply by text),
//              then books the dates Proxy hands back and reviews. Nothing is at risk.
//   plan       The agent signs up for Acme Cloud's annual plan instead of monthly, reviews before the receipt arrives,
//              says it is done and leaves. The receipt arrives late; Proxy flags the term and texts the human. After
//              UNDO ALL, billing refunds it and the demo agent re-subscribes monthly (the server's demo redo).
//   store      The agent orders a USB-A 20W charger from Northwind Market instead of the USB-C 65W one, says it is done and
//              leaves. The receipt arrives late; Proxy flags the item and texts the human. After UNDO ALL, Northwind's agent
//              offers store credit, Proxy declines, fills Northwind's return form, the simulated carrier scans the drop-off,
//              the refund is verified, and the demo agent orders the USB-C 65W charger (the server's demo redo).
//   trip-dmy   The human writes "11/3" meaning 11 March. The agent reads Nov 3, logs it with the human's words, and books the
//              flight, hotel and transfer and emails the host for Nov 3 without waiting for Proxy's question, then leaves.
//              Reply 2 (Mar 11) on /web/show or by text: Proxy finds every booking on the wrong date and sends the alert.
// The trip story is runScriptedDemo (scripted.ts).
import type { DateRange, LogIntentOutput, ReviewOutput, ToolResult } from "../types.js";
import type { DemoBookingMerchants } from "./http-merchants.js";
import type { ToolClient } from "./mcp-client.js";
import { DEMO_PREFERENCES, type DemoControl } from "./scripted.js";

export const SCENARIO_NAMES = ["trip", "trip-dmy", "ambiguous", "plan", "store"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const AMBIGUOUS_REQUEST =
  "Book me a flight SFO to JFK landing 3/11, 3 nights at Harborview from 3/11, and an airport transfer on 3/11. Under $1,500 total.";
export const DMY_REQUEST = "Book my NYC trip for the conference on 11/3, under $1,500.";
export const PLAN_REQUEST = "Sign our team up for Acme Cloud's team plan, billed monthly.";
export const STORE_REQUEST = "Order a USB-C 65W charger for my MacBook, under $60.";

export interface ScenarioAgentOptions {
  client: ToolClient;
  merchants: DemoBookingMerchants;
  control: Pick<DemoControl, "endSession"> & Partial<Pick<DemoControl, "sendHostArrival">>;
  /** The agent's clock, for booked_at (the server's demo clock decides everything else). */
  now: () => string;
  write?: (line: string) => void;
  /** How long the ambiguous agent waits for the human's 1 or 2. */
  answerTimeoutMs?: number;
  pollMs?: number;
}

export interface ScenarioAgentResult {
  task_id: string;
  review: ReviewOutput;
  /** ambiguous: the dates the agent booked after the human's answer. */
  booked_dates?: DateRange;
}

type LogIntent = ToolResult<LogIntentOutput>;

function okOrThrow<T>(r: ToolResult<T>, tool: string): { ok: true } & T {
  if (!r.ok) throw new Error(`${tool}: ${r.message}`);
  return r as { ok: true } & T;
}

const day = (iso: string) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

export async function runAmbiguousAgent(o: ScenarioAgentOptions): Promise<ScenarioAgentResult> {
  const write = o.write ?? console.log;
  const intent = {
    goal: "NYC trip: flight landing 3/11, 3 nights at Harborview and an airport transfer, under $1,500",
    // The agent reads 3/11 the American way.
    constraints: { dates: { start: "2027-03-11", end: "2027-03-14" }, budget_total: 150_000, destination: "NYC", categories: ["flight", "hotel", "transfer"] },
    preferences: DEMO_PREFERENCES,
    original_request: AMBIGUOUS_REQUEST,
    idempotency_key: "demo:ambiguous:3-11",
  };
  let logged = okOrThrow(await o.client.callTool<LogIntent>("log_intent", intent), "log_intent");
  if (logged.next_action === "wait_for_human") {
    write(`Proxy asked the human: "${logged.intent_check?.said}". Waiting for 1 or 2 (tap it on /web/show, or reply by text).`);
    const until = Date.now() + (o.answerTimeoutMs ?? 5 * 60_000);
    while (logged.next_action === "wait_for_human") {
      if (Date.now() > until) throw new Error("No answer from the human in time");
      await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
      logged = okOrThrow(await o.client.callTool<LogIntent>("log_intent", intent), "log_intent");
    }
    write(`The human answered: ${logged.intent_check?.status === "confirmed_human" ? logged.intent_check.said : "keep the agent's reading"}.`);
  }
  const dates = logged.constraints?.dates ?? intent.constraints.dates;
  const at = o.now();
  const bookings = await Promise.all([
    o.merchants.book({ merchant_id: "airline", task_id: logged.task_id, task_email: logged.task_email, item: `Flight SFO to JFK, ${day(dates.start)}`, dates: { start: dates.start }, amount: 41_200, booked_at: at }),
    o.merchants.book({ merchant_id: "hotel", task_id: logged.task_id, task_email: logged.task_email, item: `Hotel, 3 nights from ${day(dates.start)}`, dates, amount: 64_000, booked_at: at }),
    o.merchants.book({ merchant_id: "transfer", task_id: logged.task_id, task_email: logged.task_email, item: `Airport transfer, ${day(dates.start)}`, dates: { start: dates.start }, amount: 18_800, booked_at: at }),
  ]);
  // The hotel's confirmation is held back by the HTTP merchants; release it so every receipt is in before the review.
  await o.merchants.releaseConfirmation(bookings[1].ref, at);
  const review = okOrThrow(await o.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: logged.task_id }), "review");
  write(`Booked ${day(dates.start)}${dates.end ? ` to ${day(dates.end)}` : ""}; review: ${review.status}.`);
  await o.control.endSession(logged.task_id);
  return { task_id: logged.task_id, review, booked_dates: dates };
}

export async function runTripDmyAgent(o: ScenarioAgentOptions): Promise<ScenarioAgentResult> {
  const write = o.write ?? console.log;
  const dates = { start: "2026-11-03", end: "2026-11-06" };
  const logged = okOrThrow(
    await o.client.callTool<LogIntent>("log_intent", {
      goal: "NYC trip for the conference on 11/3, under $1,500",
      // The agent reads 11/3 the American way: Nov 3.
      constraints: { dates, budget_total: 150_000, destination: "NYC", categories: ["flight", "hotel", "transfer"] },
      preferences: DEMO_PREFERENCES,
      original_request: DMY_REQUEST,
      idempotency_key: "demo:trip-dmy:11-3",
    }),
    "log_intent",
  );
  if (logged.next_action === "wait_for_human") write(`Proxy asked the human: "${logged.intent_check?.said}". The agent doesn't wait and books Nov 3.`);
  // The mistake: it books without waiting for the answer.
  const at = o.now();
  await o.merchants.book({ merchant_id: "airline", task_id: logged.task_id, task_email: logged.task_email, item: "Flight SFO to JFK, Nov 3", dates: { start: dates.start }, amount: 41_200, booked_at: at });
  await o.merchants.book({ merchant_id: "hotel", task_id: logged.task_id, task_email: logged.task_email, item: "Hotel, 3 nights", dates, amount: 64_000, booked_at: at });
  await o.merchants.book({ merchant_id: "transfer", task_id: logged.task_id, task_email: logged.task_email, item: "Airport transfer, Nov 3", dates: { start: dates.start }, amount: 18_800, booked_at: at });
  await o.control.sendHostArrival?.(
    { action_id: "act_host_email", task_id: logged.task_id, merchant: "host", category: "message", summary: "Arrival email to the host, says Nov 3", amount: 0, dates: { start: dates.start }, ref: "HOST-EMAIL-001", source: "agent", received_at: at, state: "found" },
    logged.task_email,
  );
  const review = okOrThrow(await o.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: logged.task_id }), "review");
  write(`Booked Nov 3 and emailed the host; the agent's review: ${review.status}. It says it's done and leaves.`);
  // Still the agent's day: the flight is inside the 24-hour rule when Proxy reaches it.
  await o.control.endSession(logged.task_id, { late: false });
  write("Reply 2 (Mar 11) to Proxy's question on /web/show or by text: Proxy then checks the bookings and sends the alert.");
  return { task_id: logged.task_id, review, booked_dates: dates };
}

export async function runPlanAgent(o: ScenarioAgentOptions): Promise<ScenarioAgentResult> {
  const write = o.write ?? console.log;
  const logged = okOrThrow(
    await o.client.callTool<LogIntent>("log_intent", {
      goal: "Acme Cloud team plan, billed monthly",
      constraints: { categories: ["saas"], must_haves: ["term:monthly"] },
      preferences: DEMO_PREFERENCES,
      original_request: PLAN_REQUEST,
      idempotency_key: "demo:plan:acme-monthly",
    }),
    "log_intent",
  );
  // The mistake: the annual plan. Its receipt is held back, so the agent's own review sees nothing yet.
  const booked = await o.merchants.book({ merchant_id: "saas", task_id: logged.task_id, task_email: logged.task_email, item: "Acme Cloud Team plan, billed annually", amount: 118_800, booked_at: o.now() });
  const review = okOrThrow(await o.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: logged.task_id }), "review");
  write(`Signed up (${booked.ref}); the agent's review: ${review.status}. It says it's done and leaves.`);
  await o.control.endSession(logged.task_id);
  await o.merchants.releaseConfirmation(booked.ref, o.now());
  write("The receipt arrived after the agent left. Proxy texts the human in a few seconds: reply UNDO ALL on /web/show or by text.");
  return { task_id: logged.task_id, review };
}

export async function runStoreAgent(o: ScenarioAgentOptions): Promise<ScenarioAgentResult> {
  const write = o.write ?? console.log;
  const logged = okOrThrow(
    await o.client.callTool<LogIntent>("log_intent", {
      goal: "USB-C 65W charger for a MacBook, under $60",
      constraints: { categories: ["store"], budget_total: 6_000, must_haves: ["item:USB-C 65W charger"] },
      preferences: DEMO_PREFERENCES,
      original_request: STORE_REQUEST,
      idempotency_key: "demo:store:usb-c-65w",
    }),
    "log_intent",
  );
  // The mistake: the USB-A 20W charger. Its receipt is held back, so the agent's own review sees nothing yet.
  const booked = await o.merchants.book({ merchant_id: "northwind", task_id: logged.task_id, task_email: logged.task_email, item: "USB-A 20W charger", amount: 4_500, booked_at: o.now() });
  const review = okOrThrow(await o.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: logged.task_id }), "review");
  write(`Ordered from Northwind Market (${booked.ref}); the agent's review: ${review.status}. It says "Ordered" and leaves.`);
  await o.control.endSession(logged.task_id);
  await o.merchants.releaseConfirmation(booked.ref, o.now());
  write("The receipt arrived after the agent left. Proxy texts the human in a few seconds: reply UNDO ALL on /web/show or by text.");
  return { task_id: logged.task_id, review };
}
