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
import { createDemoPayments, type AgentPayments } from "./payments.js";
import { StubMerchants, type ConfirmationEnvelope, type ConfirmationSink } from "./stub-merchants.js";

export const DEFAULT_MCP_URL = "http://localhost:3000/mcp";
export const DEMO_START = "2026-11-01T14:00:00.000Z";
export const LATE_CONFIRMATION_DELAY_MS = 5 * 60_000;
export const DEMO_PREFERENCES = {
  no_store_credit: true,
  min_partial_refund_pct: 80,
  auto_undo: false,
} as const;

type Ok<T> = { ok: true } & T;

export interface DemoControl extends ConfirmationSink {
  endSession(taskId: string): Promise<void>;
  reset(): Promise<void>;
  sendHostArrival(action: Action, taskEmail: string): Promise<void>;
}

export interface DemoLogger {
  log(event: string, data?: unknown): void;
}

export interface ScriptedDemoOptions {
  client: ToolClient;
  payments: AgentPayments;
  clock: SimulatedClock;
  control: DemoControl;
  logger?: DemoLogger;
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
    endSession(taskId) {
      const url = demoHttpUrl(mcpUrl, "/demo/end-session");
      url.searchParams.set("task_id", taskId);
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
  const intent = await options.client.callTool<ToolResult<LogIntentOutput>>("log_intent", {
    goal: "NYC trip for the Nov 13 conference, under $1,500",
    constraints: {
      dates: { start: "2026-11-13", end: "2026-11-16" },
      budget_total: 150_000,
      destination: "NYC",
      categories: ["flight", "hotel", "transfer", "message"],
      must_haves: ["Conference on Nov 13"],
    },
    preferences: DEMO_PREFERENCES,
    idempotency_key: "demo:nyc-conference:2026-11-13",
  });
  assertOk(intent, "log_intent");
  logger.log("intent_logged", { task_id: intent.task_id, task_email: intent.task_email });

  const merchants = new StubMerchants(options.payments, options.control);
  const bookings = await Promise.all([
    merchants.book(booking("airline", intent.task_id, intent.task_email, "Flight SFO to JFK, Nov 3", 41_200, options.clock)),
    merchants.book(booking("hotel", intent.task_id, intent.task_email, "Hotel, 3 nights from Nov 3", 64_000, options.clock, "2026-11-06")),
    merchants.book(booking("transfer", intent.task_id, intent.task_email, "Airport transfer, Nov 3", 18_800, options.clock)),
  ]);
  logger.log("bookings_created", bookings);

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
  await options.control.sendHostArrival(hostAction, intent.task_email);
  logger.log("host_email_sent", { action_id: hostAction.action_id, date: "2026-11-03" });

  const review = await options.client.callTool<ToolResult<ReviewOutput>>("review", { task_id: intent.task_id });
  assertOk(review, "review");
  logger.log("mismatches", review.mismatches);

  let undoResult: UndoOutput | null = null;
  if (review.fixable_now.length > 0) {
    const undo = await options.client.callTool<ToolResult<UndoOutput>>("undo", {
      action_ids: review.fixable_now,
      reason: "The recorded actions use Nov 3, but the intent requires Nov 13.",
    });
    assertOk(undo, "undo");
    undoResult = undo;
    logger.log("self_undo_requested", undo);
  }

  logger.log("agent_session_complete", { task_id: intent.task_id });
  await options.control.endSession(intent.task_id);
  options.clock.advance(LATE_CONFIRMATION_DELAY_MS);

  for (const booked of bookings) {
    await merchants.releaseConfirmation(booked.ref, options.clock.now());
    options.clock.advance(1_000);
  }
  logger.log("late_confirmations_delivered", { count: bookings.length, task_id: intent.task_id });

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

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const mcpUrl = process.env.MCP_URL ?? DEFAULT_MCP_URL;
  const control = createHttpDemoControl(mcpUrl);
  if (command === "reset") {
    await resetScriptedDemo(control);
    console.log("demo_reset", { clock: DEMO_START, preferences: DEMO_PREFERENCES });
    return;
  }
  if (command !== "run") throw new Error(`Unknown command ${command}; use run or reset`);

  const client = await connectToolClient(mcpUrl);
  try {
    await runScriptedDemo({
      client,
      payments: createDemoPayments(),
      clock: createDemoClock(),
      control,
    });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
