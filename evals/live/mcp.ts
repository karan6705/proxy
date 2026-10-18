// Layer 2 over MCP: the Proxy half of an episode run against a real server instead of in process.
//
// The live agent's episode is the same as in process: a real model books through the task's faulty tools. Then the
// bookings it made are replayed against the server:
//   reset the demo, log_intent over MCP (with what the agent logged), book each booking at the server's merchants,
//   end the agent's session, release the late confirmations, wait for the chain and the one alert, call review over
//   MCP, reply UNDO ALL as the human, wait for the chain to settle, and read what Stripe verified.
// So capture, compare, trace, the orchestrator, the Reversal Protocol and refund verification are the server's own.
// Needs the server's demo routes on (PROXY_DEMO_ROUTES=1). Nothing here prints a key.

import { connectToolClient, type ToolClient } from "../../src/agent/mcp-client.js";
import { createHttpMerchants, type DemoBookingMerchants } from "../../src/agent/http-merchants.js";
import { resetDemo } from "../../src/agent/reset.js";
import { createDemoClock, createHttpDemoControl, DEMO_PREFERENCES, type DemoControl } from "../../src/agent/scripted.js";
import type { Intent, LogIntentOutput, ReviewOutput, ToolResult } from "../../src/types.js";
import type { SimBooking } from "../sim.js";

const SETTLED = new Set(["reversed", "redo_requested", "redone", "closed", "kept", "partial", "expired"]);
const ALERTED = new Set(["alerted", "undoing", ...SETTLED]);

export interface McpEpisodeInput {
  taskId: string;
  trial: number;
  logged: Pick<Intent, "goal" | "constraints"> | null;
  bookings: SimBooking[];
}

export interface McpProxyResult {
  /** The server's mismatches, mapped back to this episode's booking ids. */
  flagged: { action: string; field: string }[];
  /** Whether the server raised a chain and the one alert. */
  chain_state: string | null;
  /** Actions in the chain that Stripe shows as refunded. */
  stripe_verified_actions: number;
  /** Actions in the chain in total. */
  chain_actions: number;
  /** What the server's steps said, in order. Raw log. */
  steps: string[];
}

export interface McpDeps {
  mcpUrl: string;
  client?: ToolClient;
  merchants?: DemoBookingMerchants;
  control?: DemoControl;
  fetchImpl?: typeof fetch;
  reset?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a chain, and for it to settle. */
  waitMs?: number;
}

const slug = (ref: string): string => ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface WebChain {
  chain_id: string;
  task_id: string;
  state: string;
  actions: { action_id: string; stripe_verified: boolean }[];
  steps: { message: string }[];
}

function url(mcpUrl: string, path: string): URL {
  const target = new URL(mcpUrl);
  target.pathname = path;
  target.search = "";
  target.hash = "";
  return target;
}

export async function runProxyOverMcp(input: McpEpisodeInput, deps: McpDeps): Promise<McpProxyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? pause;
  const waitMs = deps.waitMs ?? 45_000;
  const client = deps.client ?? (await connectToolClient(deps.mcpUrl));
  const merchants = deps.merchants ?? createHttpMerchants(deps.mcpUrl, fetchImpl);
  const control = deps.control ?? createHttpDemoControl(deps.mcpUrl, fetchImpl);
  const empty: McpProxyResult = { flagged: [], chain_state: null, stripe_verified_actions: 0, chain_actions: 0, steps: [] };

  try {
    await (deps.reset ?? (() => resetDemo({ mcpUrl: deps.mcpUrl })))();

    const logged = input.logged ?? { goal: "(the agent logged no intent)", constraints: {} };
    const intent = await client.callTool<ToolResult<LogIntentOutput>>("log_intent", {
      goal: logged.goal || "(the agent logged no intent)",
      constraints: logged.constraints,
      preferences: DEMO_PREFERENCES,
      idempotency_key: `live:${input.taskId}:${input.trial}:${Date.now()}`,
    });
    if (!intent.ok) {
      throw new Error(`log_intent: ${intent.message}`);
    }

    // Book each booking at the server's merchants, one minute apart on the demo clock.
    const clock = createDemoClock();
    const refToBooking = new Map<string, string>();
    const toRelease: string[] = [];
    for (const booking of input.bookings) {
      const result = await merchants.book({
        merchant_id: booking.merchant_id,
        task_id: intent.task_id,
        task_email: intent.task_email,
        item: booking.item,
        dates: booking.dates,
        amount: booking.amount,
        booked_at: clock.now(),
      });
      refToBooking.set(`act_${intent.task_id}_${slug(result.ref)}`, booking.id);
      if (booking.merchant_id === "hotel") {
        toRelease.push(result.ref);
      }
      clock.advance(60_000);
    }

    // The agent's session ends, then the late confirmations arrive.
    await control.endSession(intent.task_id);
    clock.advance(5 * 60_000);
    for (const ref of toRelease) {
      await merchants.releaseConfirmation(ref, clock.now());
      clock.advance(1_000);
    }

    const review = await client.callTool<ToolResult<ReviewOutput>>("review", { task_id: intent.task_id });
    const flagged = review.ok
      ? review.mismatches.map((item) => ({ action: refToBooking.get(item.action_id) ?? item.action_id, field: item.field }))
      : [];

    const chain = await waitForChain(deps.mcpUrl, intent.task_id, fetchImpl, sleep, waitMs, (state) => ALERTED.has(state));
    if (!chain) {
      return { ...empty, flagged };
    }

    // The human replies UNDO ALL (the demo button), and the server undoes the chain.
    const reply = await fetchImpl(url(deps.mcpUrl, "/web/reply"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain_id: chain.chain_id, kind: "undo_all" }),
    });
    if (!reply.ok) {
      throw new Error(`POST /web/reply answered ${reply.status}`);
    }
    const settled = (await waitForChain(deps.mcpUrl, intent.task_id, fetchImpl, sleep, waitMs, (state) => SETTLED.has(state))) ?? chain;
    return {
      flagged,
      chain_state: settled.state,
      stripe_verified_actions: settled.actions.filter((item) => item.stripe_verified).length,
      chain_actions: settled.actions.length,
      steps: settled.steps.map((item) => item.message),
    };
  } finally {
    if (!deps.client) {
      await client.close().catch(() => undefined);
    }
  }
}

async function waitForChain(
  mcpUrl: string,
  taskId: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
  accept: (state: string) => boolean,
): Promise<WebChain | null> {
  const deadline = Date.now() + waitMs;
  let last: WebChain | null = null;
  while (Date.now() <= deadline) {
    const response = await fetchImpl(url(mcpUrl, "/web/state"));
    if (response.ok) {
      const body = (await response.json()) as { chains?: WebChain[] };
      const mine = (body.chains ?? []).filter((item) => item.task_id === taskId);
      last = mine.at(-1) ?? null;
      if (last && accept(last.state)) {
        return last;
      }
    }
    await sleep(1_000);
  }
  return last && accept(last.state) ? last : null;
}
