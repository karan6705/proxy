import { pathToFileURL } from "node:url";
import type {
  Action,
  BookingRequest,
  Clock,
  LogIntentOutput,
  ReviewOutput,
  SimulatedClock,
  ToolResult,
  UndoOutput,
} from "../types.js";
import { connectToolClient, type ToolClient } from "./mcp-client.js";
import { createHttpMerchants, type DemoBookingMerchants } from "./http-merchants.js";
import { createOfflineDemoControl, createOfflineToolClient } from "./offline.js";
import { createMockAgentPayments, type AgentPayments } from "./payments.js";
import { StubMerchants, type ConfirmationEnvelope, type ConfirmationSink } from "./stub-merchants.js";

export const DEFAULT_MCP_URL = "http://localhost:3000/mcp";
export const DEMO_START = "2026-10-25T14:00:00.000Z";
export const LATE_CONFIRMATION_DELAY_MS = 5 * 60_000;
export const DEMO_PREFERENCES = {
  no_store_credit: true,
  min_partial_refund_pct: 80,
  auto_undo: false,
} as const;

export const SCRIPTED_DEMO_STEPS = [
  "log_intent",
  "bookings",
  "host_email",
  "review",
  "undo",
  "end_session",
  "late_confirmations",
] as const;

export type ScriptedDemoStep = (typeof SCRIPTED_DEMO_STEPS)[number];

export interface ScriptedStepResult {
  step: ScriptedDemoStep;
  status: "PASS" | "FAIL";
  duration_ms: number;
  error?: string;
}

type Ok<T> = { ok: true } & T;

export interface DemoControl extends ConfirmationSink {
  /** `late: false` ends the session without moving the demo clock to the late confirmations' hour. */
  endSession(taskId: string, opts?: { late?: boolean }): Promise<void>;
  reset(): Promise<void>;
  sendHostArrival(action: Action, taskEmail: string): Promise<void>;
}

export interface DemoLogger {
  log(event: string, data?: unknown): void;
}

export interface ScriptedDemoOptions {
  client: ToolClient;
  payments?: AgentPayments;
  merchants?: DemoBookingMerchants;
  clock: SimulatedClock;
  control: DemoControl;
  logger?: DemoLogger;
  onStep?: (result: ScriptedStepResult) => void;
  now?: () => number;
}

export interface ScriptedDemoResult {
  task_id: string;
  task_email: string;
  review: ReviewOutput;
  undo: UndoOutput | null;
  booking_refs: string[];
}

function assertOk<T>(result: ToolResult<T>, tool: string): asserts result is Ok<T> {
  if (!result.ok) throw new Error(`${tool}: ${result.message}`);
}

export function createDemoClock(start: string = DEMO_START): SimulatedClock {
  let now = Date.parse(start);
  if (Number.isNaN(now)) throw new Error(`Invalid demo start time: ${start}`);
  return {
    mode: "simulated",
    now: () => new Date(now).toISOString(),
    nowMs: () => now,
    set(value) {
      const next = Date.parse(value);
      if (Number.isNaN(next)) throw new Error(`Invalid demo time: ${value}`);
      now = next;
    },
    advance(ms) {
      now += ms;
    },
  };
}

function demoHttpUrl(mcpUrl: string, path: string): URL {
  const url = new URL(mcpUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

async function postJson(fetchImpl: typeof fetch, url: URL, body?: unknown): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url.pathname} failed (${response.status}): ${await response.text()}`);
}

export function createHttpDemoControl(
  mcpUrl = process.env.MCP_URL ?? DEFAULT_MCP_URL,
  fetchImpl: typeof fetch = fetch,
): DemoControl {
  return {
    deliver(envelope) {
      return postJson(fetchImpl, demoHttpUrl(mcpUrl, "/demo/confirmation"), envelope);
    },
    endSession(taskId, opts) {
      const url = demoHttpUrl(mcpUrl, "/demo/end-session");
      url.searchParams.set("task_id", taskId);
      if (opts?.late === false) url.searchParams.set("late", "0");
      return postJson(fetchImpl, url);
    },
    reset() {
      return postJson(fetchImpl, demoHttpUrl(mcpUrl, "/demo/reset"), {
        clock: DEMO_START,
        preferences: DEMO_PREFERENCES,
      });
    },
    sendHostArrival(action, taskEmail) {
      return postJson(fetchImpl, demoHttpUrl(mcpUrl, "/demo/host-email"), {
        action,
        from: taskEmail,
        to: "host@demo.example",
        subject: "Arrival on Nov 3",
        body: "I’ll arrive in NYC on Nov 3 for the conference trip.",
      });
    },
  };
}

function booking(
  merchant_id: string,
  task_id: string,
  task_email: string,
  item: string,
  amount: number,
  clock: Clock,
  end?: string,
): BookingRequest {
  return {
    merchant_id,
    task_id,
    task_email,
    item,
    dates: { start: "2026-11-03", ...(end ? { end } : {}) },
    amount,
    booked_at: clock.now(),
  };
}

export async function runScriptedDemo(options: ScriptedDemoOptions): Promise<ScriptedDemoResult> {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => performance.now());
  async function step<T>(name: ScriptedDemoStep, run: () => Promise<T>): Promise<T> {
    const started = now();
    try {
      const result = await run();
      options.onStep?.({ step: name, status: "PASS", duration_ms: Math.max(0, now() - started) });
      return result;
    } catch (error) {
      options.onStep?.({
        step: name,
        status: "FAIL",
        duration_ms: Math.max(0, now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const intent = await step("log_intent", async () => {
    const result = await options.client.callTool<ToolResult<LogIntentOutput>>("log_intent", {
      goal: "NYC trip for the Nov 13 conference, under $1,500",
      constraints: {
        dates: { start: "2026-11-13", end: "2026-11-16" },
        budget_total: 150_000,
        destination: "NYC",
        categories: ["flight", "hotel", "transfer", "message"],
        must_haves: ["Conference on Nov 13"],
      },
      preferences: DEMO_PREFERENCES,
      original_request: "Book my NYC trip for the Nov 13 conference, under $1,500",
      idempotency_key: "demo:nyc-conference:2026-11-13",
    });
    assertOk(result, "log_intent");
    logger.log("intent_logged", { task_id: result.task_id, task_email: result.task_email });
    return result;
  });

  const merchants = options.merchants ?? new StubMerchants(
    options.payments ?? (() => { throw new Error("Scripted stub merchants require a Payments adapter"); })(),
    options.control,
  );
  const bookings = await step("bookings", async () => {
    const result = await Promise.all([
      merchants.book(booking("airline", intent.task_id, intent.task_email, "Flight SFO to JFK, Nov 3", 41_200, options.clock)),
      merchants.book(booking("hotel", intent.task_id, intent.task_email, "Hotel, 3 nights from Nov 3", 64_000, options.clock, "2026-11-06")),
      merchants.book(booking("transfer", intent.task_id, intent.task_email, "Airport transfer, Nov 3", 18_800, options.clock)),
    ]);
    logger.log("bookings_created", result);
    return result;
  });

  const hostAction: Action = {
    action_id: "act_host_email",
    task_id: intent.task_id,
    merchant: "host",
    category: "message",
    summary: "Arrival email to the host, says Nov 3",
    amount: 0,
    dates: { start: "2026-11-03" },
    ref: "HOST-EMAIL-001",
    source: "agent",
    received_at: options.clock.now(),
    state: "found",
  };
  await step("host_email", async () => {
    await options.control.sendHostArrival(hostAction, intent.task_email);
    logger.log("host_email_sent", { action_id: hostAction.action_id, date: "2026-11-03" });
  });

  const review = await step("review", async () => {
    const result = await options.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: intent.task_id });
    assertOk(result, "review");
    logger.log("mismatches", result.mismatches);
    return result;
  });

  const undoResult = await step("undo", async (): Promise<UndoOutput | null> => {
    if (review.fixable_now.length === 0) return null;
    const result = await options.client.callTool<ToolResult<UndoOutput>>("undo", {
      action_ids: review.fixable_now,
      reason: "The recorded actions use Nov 3, but the intent requires Nov 13.",
    });
    assertOk(result, "undo");
    logger.log("self_undo_requested", result);
    return result;
  });

  logger.log("agent_session_complete", { task_id: intent.task_id });
  await step("end_session", () => options.control.endSession(intent.task_id));

  await step("late_confirmations", async () => {
    options.clock.advance(LATE_CONFIRMATION_DELAY_MS);
    for (const booked of bookings) {
      await merchants.releaseConfirmation(booked.ref, options.clock.now());
      options.clock.advance(1_000);
    }
    logger.log("late_confirmations_delivered", { count: bookings.length, task_id: intent.task_id });
  });

  return {
    task_id: intent.task_id,
    task_email: intent.task_email,
    review,
    undo: undoResult,
    booking_refs: bookings.map((item) => item.ref),
  };
}

export async function resetScriptedDemo(control: Pick<DemoControl, "reset">): Promise<void> {
  await control.reset();
}

export function parseScriptedArgs(args: string[]): { command: string; offline: boolean } {
  return {
    command: args.find((arg) => !arg.startsWith("--")) ?? "run",
    offline: args.includes("--offline"),
  };
}

async function main(): Promise<void> {
  const { command, offline } = parseScriptedArgs(process.argv.slice(2));
  const mcpUrl = process.env.MCP_URL ?? DEFAULT_MCP_URL;
  const control = offline ? createOfflineDemoControl() : createHttpDemoControl(mcpUrl);
  if (command === "reset") {
    if (offline) await resetScriptedDemo(control);
    else {
      const { resetDemo } = await import("./reset.js");
      await resetDemo({ mcpUrl });
    }
    console.log("demo_reset", { mode: offline ? "offline" : "online", clock: DEMO_START, preferences: DEMO_PREFERENCES });
    return;
  }
  if (command !== "run") throw new Error(`Unknown command ${command}; use run or reset`);

  const client = offline ? createOfflineToolClient() : await connectToolClient(mcpUrl);
  const runStarted = performance.now();
  let passed = false;
  try {
    await runScriptedDemo({
      client,
      ...(offline ? { payments: createMockAgentPayments() } : { merchants: createHttpMerchants(mcpUrl) }),
      clock: createDemoClock(),
      control,
      onStep: offline
        ? ({ step, status, duration_ms, error }) => {
            const detail = error ? ` — ${error}` : "";
            console.log(`${status} ${step} ${Math.round(duration_ms)}ms${detail}`);
          }
        : undefined,
    });
    passed = true;
  } finally {
    await client.close();
    if (offline) console.log(`${passed ? "PASS" : "FAIL"} total ${Math.round(performance.now() - runStarted)}ms`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
