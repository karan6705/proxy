// Proxy MCP server: six tools, the mistakes resource, and mountRoutes for other folders' HTTP routes.
// Tools are stubs returning typed demo data until Store, Logic and the orchestrator are wired in.
import { createHash } from "node:crypto";
import { MCPServer } from "mcp-use";
import { createSimulatedClock } from "./orchestrator/clock.js";
import { DEFAULT_PARAMS } from "./orchestrator/params.js";
import { checkSelfUndo } from "./orchestrator/self-undo.js";
import { createSessions } from "./orchestrator/sessions.js";
import type { HttpMethod, LogIntentInput, RouteHandler, RouteRequest } from "./types.js";
import { MISTAKES_RESOURCE_URI } from "./types.js";
import { advertise, fail, handler, ok } from "./tools/result.js";
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
import {
  DEMO_CHAIN_ID,
  DEMO_NOW,
  DEMO_TASK_ID,
  demoActions,
  demoChain,
  demoChainSummary,
  demoLessons,
  demoMismatches,
  demoReversibility,
} from "./tools/stubs.js";

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

// --- stub state, replaced by Store ---
// Demo time starts at the seeded DEMO_NOW and runs at real speed, so idle sessions end on their own.
const clock = createSimulatedClock(DEMO_NOW, 1);
const sessions = createSessions(clock, DEFAULT_PARAMS.SESSION_IDLE_MS);

/** The demo actions the agent may undo itself right now (see src/orchestrator/self-undo.ts). */
function demoFixableNow(): string[] {
  const flagged = new Set(demoMismatches.map((m) => m.action_id));
  return demoActions
    .filter(
      (a) =>
        checkSelfUndo({
          flagged: flagged.has(a.action_id),
          route: a.route,
          reversibility: demoReversibility[a.category],
          session_active: sessions.isActive(DEMO_TASK_ID),
          now: clock.now(),
        }).allowed,
    )
    .map((a) => a.action_id);
}
const tasksByKey = new Map<string, { task_id: string; fingerprint: string }>();
const knownTasks = new Set<string>([DEMO_TASK_ID]);

function taskIdFor(key: string): string {
  return "task_" + createHash("sha256").update(key).digest("hex").slice(0, 12);
}

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
  handler(logIntentInput, async (input) => {
    const fingerprint = JSON.stringify({ goal: input.goal, constraints: input.constraints, preferences: input.preferences });
    const existing = tasksByKey.get(input.idempotency_key);
    if (existing && existing.fingerprint !== fingerprint) {
      return fail(
        "idempotency_conflict",
        "This idempotency_key was already used with a different intent. Use a new key for a new task.",
        false,
        "fix_now",
      );
    }
    const task_id = existing?.task_id ?? taskIdFor(input.idempotency_key);
    tasksByKey.set(input.idempotency_key, { task_id, fingerprint });
    knownTasks.add(task_id);
    sessions.touch(task_id);
    return ok({ task_id, task_email: `${task_id}@tasks.proxy.example` });
  }),
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
  handler(reversibilityInput, async (input) => ok(demoReversibility[input.category])),
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
  handler(reviewInput, async ({ task_id }) => {
    if (!knownTasks.has(task_id)) {
      return fail("not_found", `No task ${task_id}. Call log_intent first and use its task_id.`, false, "fix_now");
    }
    sessions.touch(task_id);
    if (task_id !== DEMO_TASK_ID) {
      return ok({
        status: "clean" as const,
        mismatches: [],
        fixable_now: [],
        chain_ids: [],
        evidence_seen: { emails: 0, stripe_events: 0, actions: 0 },
      });
    }
    return ok({
      status: "chain_open" as const,
      mismatches: demoMismatches,
      fixable_now: demoFixableNow(),
      chain_ids: [DEMO_CHAIN_ID],
      evidence_seen: { emails: 4, stripe_events: 3, actions: 4 },
    });
  }),
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
  handler(undoInput, async ({ action_ids }) => {
    // Enforce the self-undo rule here too: only ids that would be in review.fixable_now right now.
    if (action_ids.some((id) => demoActions.some((a) => a.action_id === id))) sessions.touch(DEMO_TASK_ID);
    const fixable = new Set(demoFixableNow());
    const accepted = action_ids.filter((id) => fixable.has(id));
    const requires_human = action_ids.filter((id) => !fixable.has(id));
    return ok({ accepted, requires_human, chain_id: accepted.length > 0 ? DEMO_CHAIN_ID : null });
  }),
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
  handler(getChainInput, async ({ chain_id }) => {
    if (chain_id !== DEMO_CHAIN_ID) {
      return fail("not_found", `No chain ${chain_id}. Use a chain_id from review or list_chains.`, false, "fix_now");
    }
    return ok(demoChain);
  }),
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
  handler(listChainsInput, async ({ task_id }) => ok({ chains: task_id === undefined || task_id === DEMO_TASK_ID ? [demoChainSummary] : [] })),
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
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ lessons: demoLessons }) }],
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

// Scripted demo only: the demo agent ends its session before the late confirmations arrive,
// so the whole chain goes to the human. Off unless PROXY_DEMO_ROUTES=1.
if (process.env.PROXY_DEMO_ROUTES === "1") {
  mountRoutes([
    {
      method: "POST",
      path: "/demo/end-session",
      handle: async (req) => {
        const task_id = req.query.task_id;
        if (!task_id) return { status: 400, body: { ok: false, message: "task_id query parameter is required" } };
        sessions.end(task_id);
        return { status: 200, body: { ok: true, task_id, session_active: false } };
      },
    },
  ]);
}

export default server;
