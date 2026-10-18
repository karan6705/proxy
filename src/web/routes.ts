// The live demo page: event feed, chain list, and fallback buttons for UNDO ALL / PICK / KEEP.
//   GET  /web                 the reply page (current run only; ?all=1 shows every run, ?task_id=<id> picks one)
//   GET  /web/state           JSON the page polls
//   POST /web/reply           {chain_id, kind: "undo_all" | "pick" | "keep", picks?: number[]}  (only when controls are on)
//   GET  /web/stage           the full-screen 16:9 view for screen recording (reads GET /demo/feed)
//   GET  /web/stage-fixture   a built-in demo story for the stage page: ?step=N, or it advances by itself; ?long=1 is a long run
import type { EventReader } from "../db/memory.js";
import type { HumanChannel } from "../inkbox/human.js";
import type { Clock, EventRow, RouteHandler, Store } from "../types.js";
import { PAGE_HTML } from "./page.js";
import { fixtureFeed, fixtureSteps } from "./stage-feed.js";
import { STAGE_HTML } from "./stage.js";

export interface WebDeps {
  store: Store & EventReader;
  clock: Clock;
  /** Needed for the buttons. They act exactly like a text from the registered human number. */
  channel?: HumanChannel;
  humanNumber?: string;
  /** Buttons are off unless this is true (the server passes PROXY_DEMO_ROUTES === "1"). */
  controls?: boolean;
  /** The current demo run's task id (for example `() => proxy.deps.demo?.current`). /web shows only this run. */
  currentTask?: () => string | null | undefined;
  /** Optional shared secret for POST /web/reply, sent as the x-demo-token header. */
  token?: string;
  /** Latest scoreboard JSON, written by the eval runner. Shown as-is if present. */
  scoreboard?: () => Promise<unknown | null>;
}

const EVENT_LIMIT = 80;
const lastAlertMs = (c: { alerts: { sent_at: string }[] }) => c.alerts.reduce((t, a) => Math.max(t, Date.parse(a.sent_at)), 0);

export function createWebRoutes(deps: WebDeps): RouteHandler[] {
  let fixtureStartedAt: number | null = null;
  const controls = Boolean(deps.controls && deps.channel && deps.humanNumber);

  return [
    {
      method: "GET",
      path: "/web",
      handle: async () => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: PAGE_HTML }),
    },
    {
      method: "GET",
      path: "/web/state",
      async handle(req) {
        const all = await deps.store.listChains();
        // Only the current run: an explicit ?task_id, else the run the server says is current, else the newest.
        const newestTask = [...all].sort((a, b) => lastAlertMs(b) - lastAlertMs(a))[0]?.task_id ?? null;
        const task_id = req.query.task_id || deps.currentTask?.() || newestTask;
        const showAll = req.query.all === "1";
        const chains = showAll || !task_id ? all : all.filter((c) => c.task_id === task_id);
        const withActions = await Promise.all(
          chains.map(async (c) => ({
            chain_id: c.chain_id,
            task_id: c.task_id,
            state: c.state,
            money_at_risk: c.money_at_risk,
            window_ends_at: c.window_ends_at,
            alerts: c.alerts.map((a) => ({ channel: a.channel, kind: a.kind, sent_at: a.sent_at })),
            steps: c.steps.map((s) => ({ action_id: s.action_id, route: s.route, outcome: s.outcome, message: s.message, at: s.at })),
            actions: (await Promise.all(c.action_ids.map((id) => deps.store.getAction(id)))).flatMap((a) =>
              a ? [{ action_id: a.action_id, merchant: a.merchant, category: a.category, summary: a.summary, amount: a.amount, state: a.state, stripe_verified: a.state === "verified" }] : [],
            ),
          })),
        );
        const events = (await deps.store.recentEvents(EVENT_LIMIT * 4)).filter((e: EventRow) => showAll || !task_id || !e.task_id || e.task_id === task_id).slice(0, EVENT_LIMIT).map((e: EventRow) => ({
          timestamp: e.timestamp, kind: e.kind, outcome: e.outcome, tool_name: e.tool_name, chain_id: e.chain_id, task_id: e.task_id,
        }));
        return { status: 200, headers: { "cache-control": "no-store" }, body: { now: deps.clock.now(), controls, task_id: showAll ? null : task_id, hidden_chains: all.length - chains.length, chains: withActions, events, scoreboard: (await deps.scoreboard?.()) ?? null } };
      },
    },
    {
      method: "POST",
      path: "/web/reply",
      async handle(req) {
        if (!controls) return { status: 404, body: { ok: false, message: "controls are off" } };
        if (deps.token && req.headers["x-demo-token"] !== deps.token) return { status: 401, body: { ok: false, message: "bad token" } };
        let body: { chain_id?: unknown; kind?: unknown; picks?: unknown };
        try {
          body = JSON.parse(req.rawBody);
        } catch {
          return { status: 400, body: { ok: false, message: "invalid JSON" } };
        }
        const picks = Array.isArray(body.picks) && body.picks.every((n) => Number.isInteger(n) && n >= 1 && n <= 99) ? (body.picks as number[]) : undefined;
        const text = body.kind === "undo_all" ? "UNDO ALL" : body.kind === "keep" ? "KEEP" : body.kind === "pick" ? (picks?.length ? `PICK ${picks.join(" ")}` : "PICK") : null;
        if (!text || typeof body.chain_id !== "string") return { status: 400, body: { ok: false, message: "chain_id and kind (undo_all, pick, keep) are required" } };
        // The button names its own chain, so a tap always lands on the chain it was drawn for.
        const chain = await deps.store.getChain(body.chain_id);
        if (!chain) return { status: 404, body: { ok: false, message: "unknown chain" } };
        const result = await deps.channel!.handleInbound({ from: deps.humanNumber!, body: text, via: "sms", chain_id: body.chain_id });
        return { status: 200, body: { ok: true, result } };
      },
    },
    {
      method: "GET",
      path: "/web/stage",
      handle: async () => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: STAGE_HTML }),
    },
    {
      method: "GET",
      path: "/web/stage-fixture",
      async handle(req) {
        // ?step=N shows exactly N steps. Otherwise the story advances by itself every 2.5 s from the first request
        // (?restart=1 starts it again), which is what a rehearsal or a screen recording wants.
        if (req.query.restart === "1") fixtureStartedAt = null;
        let step: number;
        if (req.query.step !== undefined && req.query.step !== "") step = Number(req.query.step);
        else {
          fixtureStartedAt ??= Date.now();
          step = Math.floor((Date.now() - fixtureStartedAt) / 2500);
        }
        if (!Number.isFinite(step)) return { status: 400, body: { ok: false, message: "step must be a number" } };
        const long = req.query.long === "1";
        const total = fixtureSteps(long).length;
        return { status: 200, headers: { "cache-control": "no-store" }, body: { ...fixtureFeed(step, long), step: Math.min(step, total), steps: total } };
      },
    },
  ];
}
