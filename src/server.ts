// Proxy MCP server: six tools, the mistakes resource, and mountRoutes for other folders' HTTP routes.
// Tools run on the orchestrator with in-memory stand-ins until Sarah's and Dhwanil's code merges.
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { createSimulatedClock } from "./orchestrator/clock.js";
import { DEFAULT_PARAMS } from "./orchestrator/params.js";
import { createRuntime, type Runtime } from "./orchestrator/runtime.js";
import type { Action, HttpMethod, Preferences, RouteHandler, RouteRequest } from "./types.js";
import { MISTAKES_RESOURCE_URI } from "./types.js";
import { createToolHandlers } from "./tools/handlers.js";
import { advertise, handler } from "./tools/result.js";
import {
  getChainInput,
  getChainOutput,
  listChainsInput,
  listChainsOutput,
  logIntentInput,
  logIntentOutput,
  reversibilityInput,
  reversibilityOutput,
  reviewInput,
  reviewOutput,
  undoInput,
  undoOutput,
} from "./tools/schemas.js";
import { DEMO_NOW } from "./tools/stubs.js";

const server = new MCPServer({
  name: "proxy",
  title: "Proxy",
  version: "0.1.0",
  description: "The undo layer for AI agents: catches real-world mistakes, traces what they broke, and undoes it.",
  instructions:
    "Call log_intent at the start of any task that books, buys, signs up or emails, and use the returned task_email for every booking. " +
    "Call reversibility before an action you are unsure about. Call review before you tell the human you are done. " +
    "Every error has retryable and next_action; follow next_action.",
  // Browser-based MCP clients (web inspectors, web chat clients) need CORS. Reflects the caller's Origin.
  // No cookies or credentials are used, so reflecting is safe; add allowedOrigins to restrict callers.
  cors: {},
});

// Demo time starts at the seeded DEMO_NOW and runs at real speed, so idle sessions end on their own.
const clock = createSimulatedClock(DEMO_NOW, 1);
let runtime: Runtime = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES);
const tools = createToolHandlers(() => runtime.proxy);

const writeHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const logIntent = server.tool(
  {
    name: "log_intent",
    title: "Log intent",
    description:
      "Records what the human asked for before you act, and returns a task_email unique to this task. " +
      "Call it first, at the start of any task that books, buys, signs up or emails someone. " +
      "Next: use task_email as the contact email for every booking and signup in this task, then call review(task_id) before you finish. " +
      "Idempotent on idempotency_key.",
    inputSchema: advertise(logIntentInput),
    outputSchema: logIntentOutput,
    annotations: writeHints,
  },
  handler(logIntentInput, tools.log_intent),
);

export const reversibility = server.tool(
  {
    name: "reversibility",
    title: "Check reversibility",
    description:
      "Says how undoable an action would be before you take it: the kind of undo, when the window closes, whether it is refundable, and what reversing costs. " +
      "Call it before a purchase you are not sure matches the intent. " +
      "Next: if refundable is false or the window is short, confirm the details against the intent before acting.",
    inputSchema: advertise(reversibilityInput),
    outputSchema: reversibilityOutput,
    annotations: readHints,
  },
  handler(reversibilityInput, tools.reversibility),
);

export const review = server.tool(
  {
    name: "review",
    title: "Review task",
    description:
      "Compares the receipts and Stripe charges that reached this task's email with the logged intent, and returns the exact mismatches. " +
      "Call it before you tell the human the task is done. " +
      "Next: if status is chain_open, call undo with the ids in fixable_now, then redo those actions correctly. If status is clean, you are done.",
    inputSchema: advertise(reviewInput),
    outputSchema: reviewOutput,
    annotations: readHints,
  },
  handler(reviewInput, tools.review),
);

export const undo = server.tool(
  {
    name: "undo",
    title: "Undo actions",
    description:
      "Starts undoing your own actions in this task that review flagged and that are free to undo with a full refund. " +
      "Call it only with ids from review.fixable_now, during your session. Anything with a cost, a partial refund or a negotiation, or anything after your session ends, is returned in requires_human: the human decides it by text. " +
      "Next: call get_chain(chain_id) to follow progress; when it returns redo, book what it says using the task email.",
    inputSchema: advertise(undoInput),
    outputSchema: undoOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  handler(undoInput, tools.undo),
);

export const getChain = server.tool(
  {
    name: "get_chain",
    title: "Get chain",
    description:
      "Returns one chain: each action's undo state, money at risk, time left, negotiation rounds, and the redo instruction once the chain is reversed. " +
      "Call it after undo, or when review or list_chains gives you a chain_id. " +
      "Next: follow next_action. wait_for_human means the human is deciding; redo means book what redo says, using the task email.",
    inputSchema: advertise(getChainInput),
    outputSchema: getChainOutput,
    annotations: readHints,
  },
  handler(getChainInput, tools.get_chain),
);

export const listChains = server.tool(
  {
    name: "list_chains",
    title: "List chains",
    description:
      "Lists open chains, ranked by money at risk and time left, for one task or all tasks. " +
      "Call it to find chains you have not seen yet, for example after a late confirmation. " +
      "Next: call get_chain on the first one.",
    inputSchema: advertise(listChainsInput),
    outputSchema: listChainsOutput,
    annotations: readHints,
  },
  handler(listChainsInput, tools.list_chains),
);

server.resource(
  {
    name: "mistakes",
    uri: MISTAKES_RESOURCE_URI,
    title: "Past mistakes",
    description: "Past agent mistakes and the lesson from each. Read it before a task like one that went wrong before.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await tools.mistakes()) }],
  }),
);

// --- HTTP routes from other folders (webhooks, merchant endpoints, demo page) ---

const RESERVED_PREFIXES = ["/mcp", "/inspector"];

/** Mounts RouteHandlers from src/stripe/, src/capture/, src/inkbox/, src/merchants/ and src/web/ on the server. */
export function mountRoutes(handlers: RouteHandler[]): void {
  const seen = new Set<string>();
  for (const h of handlers) {
    const key = `${h.method} ${h.path}`;
    if (!h.path.startsWith("/")) throw new Error(`Route path must start with "/": ${key}`);
    if (RESERVED_PREFIXES.some((p) => h.path === p || h.path.startsWith(p + "/"))) {
      throw new Error(`Route path is reserved by the MCP server: ${key}`);
    }
    if (seen.has(key)) throw new Error(`Route mounted twice: ${key}`);
    seen.add(key);

    server.app.on(h.method, h.path, async (c) => {
      const req: RouteRequest = {
        method: c.req.method as HttpMethod,
        path: c.req.path,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        query: c.req.query(),
        rawBody: await c.req.text(),
      };
      const res = await h.handle(req);
      const isText = typeof res.body === "string" || res.body === undefined;
      const headers = { ...(isText ? {} : { "content-type": "application/json" }), ...res.headers };
      const body = res.body === undefined ? null : isText ? (res.body as string) : JSON.stringify(res.body);
      return new Response(body, { status: res.status, headers });
    });
  }
}

mountRoutes([
  {
    method: "GET",
    path: "/health",
    handle: async () => ({ status: 200, body: { ok: true } }),
  },
]);

// Scripted demo only, off unless PROXY_DEMO_ROUTES=1. The demo agent resets state, sends the host
// email and the (late) merchant confirmations here, and ends its session before they arrive.
const demoAction = z.object({
  action_id: z.string().min(1),
  task_id: z.string().min(1),
  merchant: z.string().min(1),
  category: z.enum(["flight", "hotel", "transfer", "saas", "store", "message"]),
  summary: z.string(),
  amount: z.number().int().nonnegative(),
  dates: z.object({ start: z.string(), end: z.string().optional() }).optional(),
  ref: z.string(),
  source: z.enum(["email", "stripe", "agent"]),
  received_at: z.string(),
  state: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
const demoReset = z.object({
  clock: z.string().optional(),
  preferences: z.object({ no_store_credit: z.boolean(), min_partial_refund_pct: z.number(), auto_undo: z.boolean() }).partial().optional(),
});
const demoConfirmation = z.object({ action: demoAction, stripe_charge_id: z.string().min(1), task_email: z.string() }).passthrough();
const demoHostEmail = z.object({ action: demoAction, from: z.string(), to: z.string(), subject: z.string(), body: z.string() });

function parseBody<S extends z.ZodType>(schema: S, req: RouteRequest): z.output<S> | string {
  let json: unknown;
  try {
    json = req.rawBody === "" ? {} : JSON.parse(req.rawBody);
  } catch {
    return "Body is not valid JSON";
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

const bad = (message: string) => ({ status: 400, body: { ok: false, message } });

if (process.env.PROXY_DEMO_ROUTES === "1") {
  mountRoutes([
    {
      method: "POST",
      path: "/demo/reset",
      handle: async (req) => {
        const body = parseBody(demoReset, req);
        if (typeof body === "string") return bad(body);
        try {
          clock.set(body.clock ?? DEMO_NOW);
        } catch {
          return bad("clock must be an ISO timestamp");
        }
        const preferences: Preferences = { ...DEFAULT_PARAMS.DEFAULT_PREFERENCES, ...body.preferences };
        runtime = createRuntime(clock, DEFAULT_PARAMS, preferences);
        return { status: 200, body: { ok: true, clock: clock.now(), preferences } };
      },
    },
    {
      method: "POST",
      path: "/demo/confirmation",
      handle: async (req) => {
        const body = parseBody(demoConfirmation, req);
        if (typeof body === "string") return bad(body);
        const action = { ...body.action, source: "email", state: "found", received_at: clock.now() } as Action;
        if (!(await runtime.store.getIntent(action.task_id))) return bad(`Unknown task ${action.task_id}`);
        // Let the fake Stripe and the stand-in airline know about the booking, so self-serve undo can run.
        runtime.fakePayments?.addCharge(body.stripe_charge_id, action.action_id, action.amount);
        runtime.merchants.bookings.set(action.ref, {
          request: {
            merchant_id: action.merchant,
            task_id: action.task_id,
            task_email: body.task_email,
            item: action.summary,
            ...(action.dates ? { dates: action.dates } : {}),
            amount: action.amount,
            booked_at: body.action.received_at,
          },
          charge_id: body.stripe_charge_id,
          cancelled: false,
        });
        await runtime.proxy.onAction(action);
        return { status: 200, body: { ok: true, action_id: action.action_id } };
      },
    },
    {
      method: "POST",
      path: "/demo/host-email",
      handle: async (req) => {
        const body = parseBody(demoHostEmail, req);
        if (typeof body === "string") return bad(body);
        const action = { ...body.action, source: "agent", state: "found", received_at: clock.now() } as Action;
        if (!(await runtime.store.getIntent(action.task_id))) return bad(`Unknown task ${action.task_id}`);
        await runtime.proxy.onAction(action);
        return { status: 200, body: { ok: true, action_id: action.action_id } };
      },
    },
    {
      method: "POST",
      path: "/demo/end-session",
      handle: async (req) => {
        const task_id = req.query.task_id;
        if (!task_id) return bad("task_id query parameter is required");
        runtime.proxy.deps.sessions.end(task_id);
        return { status: 200, body: { ok: true, task_id, session_active: false } };
      },
    },
  ]);
}

export default server;
