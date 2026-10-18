// Builds the server's orchestrator from what is available: Sarah's Store (Supabase from env, else in
// memory), capture and human channel; her Inkbox client when INKBOX_API_KEY or INKBOX_DRY_RUN is set;
// real Stripe test mode when a sk_test_ key is set. Logic and Merchants stay stand-ins until Dhwanil's merge.
import { createAnthropicExtractor, createCapture, createInboundEmailRoute, deliverToCapture, type Capture } from "../capture/index.js";
import { createMemoryStore, createStoreFromEnv } from "../db/index.js";
import { createA2AAccess, createClient, createVerifier, createHumanChannel, createHumanRoutes, createInkbox, createProtocolInbox, type A2AAccess, type HumanChannel, type ProtocolInbox } from "../inkbox/index.js";
import { logic } from "../logic/index.js";
import {
  addressMode,
  createInkboxDeliver,
  createMerchants,
  merchantRoutes,
  narrateSupport,
  type MerchantDeps,
  type MerchantsImpl,
} from "../merchants/index.js";
import { createPayments, createTestCharge } from "../stripe/index.js";
import { createWebRoutes } from "../web/index.js";
import type { EventReader } from "../db/index.js";
import type { Action, Chain, Clock, Inkbox, OrchestratorHooks, Params, Payments, Preferences, RouteHandler, Store, TaskId } from "../types.js";
import { createFakePayments } from "./fakes.js";
import { createProxy, type DemoTask, type Proxy } from "./proxy.js";
import { createSessions } from "./sessions.js";
import { createStandInInkbox } from "./standin-inkbox.js";
import type { ProtocolTransport } from "./undo.js";
import { createRateLimitState, guardAccess, schedulePolls, throttledLog, type PollSchedule } from "./poll-guard.js";
import { frontHumanChannel } from "./human-front.js";
import { withIntentUpdates } from "./intent-store.js";
import { protocolSubject } from "../inkbox/index.js";

/** Stands in for the human's number in the demo when HUMAN_PHONE isn't set. Nothing is ever sent to it. */
export const DEMO_HUMAN_NUMBER = "+10000000000";

export interface Runtime {
  proxy: Proxy;
  store: Store;
  human: HumanChannel;
  capture: Capture;
  /** Sarah's webhooks: /inkbox/inbound, /inkbox/text, /inkbox/imessage. */
  routes: RouteHandler[];
  /** Present when payments are faked (no sk_test_ key); demo routes register charges here. */
  fakePayments: ReturnType<typeof createFakePayments> | null;
  merchants: MerchantsImpl;
}

export interface RuntimeOverrides {
  /** Replaces how protocol messages reach merchant agents (tests: a silent or scripted merchant). */
  transport?: ProtocolTransport;
  store?: Store;
  inkbox?: Inkbox;
  env?: NodeJS.ProcessEnv;
}

/** Fetches the stored message so capture gets the HTML (and its JSON-LD); the webhook carries plain text only. */
async function fetchFullMessage(m: { id: string; email_address: string | null }) {
  if (!m.email_address || !process.env.INKBOX_API_KEY) return null;
  const client = await createClient();
  const identity = await client.getIdentity(m.email_address.split("@")[0]);
  const full = await identity.getMessage(m.id);
  return { html: full.bodyHtml ?? undefined, text: full.bodyText ?? undefined };
}

/**
 * Demo only: mail to the demo identity (task-demo@...) is captured as task "task_demo". These wrappers
 * re-point it to the current run (task_demo_N) before it reaches the Store or the orchestrator, so every
 * run reuses one Inkbox identity and keeps its own rows.
 */
function repointDemo(store: Store, hooks: OrchestratorHooks, demo: DemoTask): { store: Store; hooks: Pick<OrchestratorHooks, "onAction"> } {
  const task = (id: TaskId | null) => (id === demo.identityTaskId && demo.current ? demo.current : id);
  const action = (a: Action): Action => {
    const t = task(a.task_id) as TaskId;
    if (t === a.task_id) return a;
    // Capture names actions act_<task>_<ref>; keep run ids distinct so earlier runs aren't overwritten.
    const action_id = a.action_id.replace(`act_${demo.identityTaskId}_`, `act_${t}_`);
    return { ...a, task_id: t, action_id };
  };
  return {
    store: {
      ...store,
      getIntent: (id) => store.getIntent(task(id) as TaskId),
      listActions: (id) => store.listActions(task(id) as TaskId),
      upsertAction: (a) => store.upsertAction(action(a)),
      logEvent: (row) => store.logEvent({ ...row, task_id: task(row.task_id) }),
    },
    hooks: { onAction: (a) => hooks.onAction(action(a)) },
  };
}

function withKnownCharges(payments: Payments, known: ReadonlyMap<string, string>): Payments {
  return { ...payments, async findChargeForAction(action) { return known.get(action.action_id) ?? payments.findChargeForAction(action); } };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * The cloud judge copy (PROXY_MODE=cloud) can never reach a real service, whatever keys are in its environment:
 * in-memory store, stand-in Inkbox that sends nothing, simulated payments, no model calls, no human number.
 */
export const isCloud = (env: NodeJS.ProcessEnv): boolean => env.PROXY_MODE === "cloud";

/** In cloud mode the Inkbox webhooks and the mock merchants' endpoints are not mounted at all (404). */
export function routesFor(routes: RouteHandler[], cloud: boolean): RouteHandler[] {
  return cloud ? routes.filter((r) => !(r.path.startsWith("/inkbox/") || r.path.startsWith("/merchants") || r.path === "/web/reply")) : routes;
}

export function createRuntime(clock: Clock, params: Params, defaultPreferences: Preferences, overrides: RuntimeOverrides = {}): Runtime {
  const env = overrides.env ?? process.env;
  const cloud = isCloud(env);
  // Intents can be changed by the human's answers; see intent-store.ts.
  const store = withIntentUpdates(overrides.store ?? (cloud ? createMemoryStore() : createStoreFromEnv(env)));
  const useInkbox = !cloud && (Boolean(env.INKBOX_API_KEY?.trim()) || env.INKBOX_DRY_RUN === "1");
  const inkbox = overrides.inkbox ?? (useInkbox ? createInkbox({ store, clock }) : createStandInInkbox());
  const useStripe = !cloud && (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
  const fakePayments = useStripe ? null : createFakePayments();
  // Simulated payments (the offline recording, the sandbox) say so in every text instead of plain "Stripe".
  const paymentsName = fakePayments && (cloud || env.PROXY_SIMULATED_PAYMENTS === "1") ? "Stripe (simulated)" : "Stripe";
  const fakeChargesByKey = new Map<string, string>();
  let fakeChargeSequence = 0;
  let capture: Capture | null = null;
  const mode = addressMode(env);
  const liveDeliver = !cloud && mode === "real" ? createInkboxDeliver({ env }) : null;
  // Charge ids by action, remembered when the merchant charges. Stripe's search is eventually consistent,
  // so a refund right after a booking can't rely on it alone; the search stays as the fallback.
  const chargeByAction = new Map<string, string>();
  const chargeScope = `rt${Date.now().toString(36)}`;
  const merchantDeps: MerchantDeps = {
    async charge(args) {
      const action_id = `act_${args.task_id}_${args.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      if (fakePayments) {
        const existing = fakeChargesByKey.get(args.idempotency_key);
        if (existing) return { charge_id: existing };
        const charge_id = `ch_demo_${++fakeChargeSequence}`;
        fakeChargesByKey.set(args.idempotency_key, charge_id);
        fakePayments.addCharge(charge_id, action_id, args.amount);
        chargeByAction.set(action_id, charge_id);
        return { charge_id };
      }
      const result = await createTestCharge(
        {
          action_id,
          task_id: args.task_id,
          merchant: args.merchant,
          category: args.merchant === "airline" ? "flight" : args.merchant === "hotel" ? "hotel" : args.merchant === "transfer" ? "transfer" : "message",
          summary: args.description,
          amount: args.amount,
          ref: args.ref,
          source: "email",
          received_at: clock.now(),
          state: "found",
        },
        // Scoped to this runtime: a demo reset reuses task ids, and must still get fresh test charges.
        `${chargeScope}:${args.idempotency_key}`,
      );
      chargeByAction.set(action_id, result.charge_id);
      return { charge_id: result.charge_id };
    },
    async deliver(email) {
      // An in-process merchant (Northwind Market) has no Inkbox identity: its emails go straight to capture.
      if (liveDeliver && !(email.identity && merchants.inProcess(email.identity))) return liveDeliver(email);
      if (!capture) throw new Error("Capture is not ready for merchant email delivery");
      return deliverToCapture(capture)(email);
    },
  };
  // The simulated carrier scans a returned package PROXY_CARRIER_SCAN_MS after its label (default 4 s; at once in
  // the cloud sandbox), and moves a simulated clock to the next day first, like a real drop-off.
  const simulated = "advance" in clock ? (clock as Clock & { advance(ms: number): void }) : null;
  const merchants = createMerchants(merchantDeps, {
    addresses: mode,
    carrier: {
      scan_delay_ms: env.PROXY_CARRIER_SCAN_MS ? Number(env.PROXY_CARRIER_SCAN_MS) : cloud ? 0 : 4_000,
      ...(simulated ? { advance: (ms: number) => simulated.advance(ms) } : {}),
    },
  });

  // Real Inkbox carries the protocol; without it (no key, or INKBOX_DRY_RUN=1) the in-process mock merchant
  // agent answers instead, so the whole negotiation still runs. PROXY_PROTOCOL_LOOPBACK=1 or 0 forces either.
  const realInkbox = !cloud && Boolean(env.INKBOX_API_KEY?.trim()) && env.INKBOX_DRY_RUN !== "1";
  const loopbackAll = cloud || (env.PROXY_PROTOCOL_LOOPBACK ? env.PROXY_PROTOCOL_LOOPBACK === "1" : !realInkbox);
  let proxyRef: Proxy | null = null;
  const transport: ProtocolTransport = overrides.transport ?? {
    async send(merchant, to_identity, message, via = "default") {
      // An in-process merchant's agent always answers here, even when the other merchants are on real Inkbox.
      const loopback = loopbackAll || merchants.inProcess(merchant);
      if (!loopback && via === "email") {
        // Follow-up when the agent hasn't answered: the same JSON by email; the merchant bridge reads it.
        await inkbox.sendEmail({ to: `${to_identity}@inkboxmail.com`, subject: protocolSubject(message.type, message.negotiation_id), body: JSON.stringify(message) });
        return;
      }
      if (!loopback) {
        await inkbox.sendProtocolMessage(to_identity, message);
        return;
      }
      const agent = merchants.agent(merchant);
      if (!agent) throw new Error(`No merchant agent for ${merchant}`);
      // The mock agent answers in the background, like a message arriving later (paced in the demo).
      const pace = demoOn ? Math.max(0, Number(env.DEMO_PACE_MS ?? process.env.DEMO_PACE_MS ?? 2500) || 0) * 0.8 : 0;
      setTimeout(() => {
        agent
          .respond(message, clock.now())
          .then((answer) => proxyRef?.onProtocolMessage(answer))
          .catch((e) => console.error("[protocol] loopback answer failed:", e));
      }, pace);
    },
  };
  const humanPhone = cloud ? "" : (env.HUMAN_PHONE?.trim() ?? "");
  const demoOn = env.PROXY_DEMO_ROUTES === "1";
  // The demo page's buttons act as the registered human. With no real number they use a placeholder that is never texted.
  const humanNumber = humanPhone || (demoOn ? DEMO_HUMAN_NUMBER : "");
  const alertChannel = env.HUMAN_ALERT_CHANNEL === "sms" ? "sms" : "imessage";

  // The support desks' emails and answers, printed on the server terminal like the hotel agent's (Dhwanil's narration).
  const narrated: MerchantsImpl = {
    ...merchants,
    async supportEmail(merchant_id, email, now) {
      const reply = await merchants.supportEmail(merchant_id, email, now);
      if (merchant_id !== "host") {
        const { received, replied } = narrateSupport(email, reply);
        console.log(`[${merchant_id} support] ${received}`);
        console.log(`[${merchant_id} support] ${replied}`);
      }
      return reply;
    },
  };

  const proxy = createProxy({
    store,
    logic,
    inkbox,
    payments: withKnownCharges(fakePayments ? fakePayments.payments : createPayments(), chargeByAction),
    merchants: narrated,
    sessions: createSessions(clock, params.SESSION_IDLE_MS),
    clock,
    // The demo waits 60 s for a merchant agent before following up by email.
    params: {
      ...params,
      MERCHANT_REPLY_TIMEOUT: env.PROXY_AGENT_TIMEOUT_MS ? Number(env.PROXY_AGENT_TIMEOUT_MS) : demoOn ? 60_000 : params.MERCHANT_REPLY_TIMEOUT,
      // Pacing for the screen, demo mode only (PROXY_DEMO_ROUTES=1): DEMO_PACE_MS, default 2.5 s. Never outside the demo.
      DEMO_PACE_MS: demoOn ? Math.max(0, Number(env.DEMO_PACE_MS ?? process.env.DEMO_PACE_MS ?? 2500) || 0) : 0,
      // Proxy reminds the human once if they haven't chosen between a merchant's offers (short in the demo).
      COUNTER_REMIND_MS: env.PROXY_COUNTER_REMIND_MS ? Number(env.PROXY_COUNTER_REMIND_MS) : demoOn ? 60_000 : 30 * 60_000,
      DEMO_SEQUENTIAL: demoOn && (env.PROXY_DEMO_SEQUENTIAL === "1" || Math.max(0, Number(env.DEMO_PACE_MS ?? process.env.DEMO_PACE_MS ?? 2500) || 0) > 0),
    },
    defaultPreferences,
    demo: env.PROXY_DEMO_ROUTES === "1" ? { identityTaskId: env.INKBOX_DEMO_TASK_ID?.trim() || "task_demo", current: null } : null,
    paymentsName,
    humanNumber,
    canTextHuman: Boolean(humanPhone),
    humanChannel: alertChannel,
    transport,
    proxyEmail: `${env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent"}@inkboxmail.com`,
    alertSettleMs: env.PROXY_ALERT_SETTLE_MS ? Number(env.PROXY_ALERT_SETTLE_MS) : undefined,
    // The demo agent rebooks with the corrected intent once the chain is reversed, so the redo is visible.
    onRedoRequested: demoOn && env.PROXY_DEMO_REDO !== "0" ? (chain) => demoRedo(chain) : undefined,
  });
  proxyRef = proxy;
  merchants.onCarrierScan((scan) => {
    proxy.undo.onCarrierScan(scan).catch((e) => console.error("[returns] carrier scan failed:", e instanceof Error ? e.message : e));
  });

  /**
   * Demo only: what the buying agent does with the redo instruction. It rebooks each reversed booking for the
   * intent's dates (new Stripe test charges); the confirmations arrive like any other and Proxy checks them.
   */
  async function demoRedo(chain: Chain) {
    const intent = await store.getIntent(chain.task_id);
    const dates = intent?.constraints.dates;
    if (!intent) return;
    const old = (await Promise.all(chain.action_ids.map((id) => store.getAction(id)))).filter((a): a is Action => a !== null);
    const seen = new Set<string>();
    // Refunded bookings, and one the human kept as store credit (rebooked with that credit), are booked again.
    const credited = new Set(chain.plan.filter((p) => (p.credit_amount ?? 0) > 0).map((p) => p.action_id));
    const todo = old.filter((a) => a.category !== "message" && (a.state === "verified" || (a.state === "kept" && credited.has(a.action_id))) && !seen.has(a.category) && seen.add(a.category));
    const run = async () => {
      for (const a of todo) {
        await new Promise((r) => setTimeout(r, Number(env.PROXY_DEMO_REDO_GAP_MS ?? 1500)));
        // A subscription is redone on the monthly plan, at a twelfth of the annual price.
        if (a.category === "saas") {
          const item = a.summary.replace(/,?\s*(?:billed\s+)?(?:annually|annual|yearly)\b/i, ", billed monthly");
          await merchants.book({ merchant_id: a.merchant, task_id: intent.task_id, task_email: intent.task_email, item, amount: Math.round(a.amount / 12), booked_at: clock.now() });
          continue;
        }
        // A wrong item is ordered again as the item the task asked for, at the merchant's price.
        if (a.category === "store") {
          const wanted = (intent.constraints.must_haves ?? []).map((m) => /^\s*item\s*:\s*(.+?)\s*$/i.exec(m)?.[1]).find(Boolean);
          if (!wanted) continue;
          await merchants.book({ merchant_id: a.merchant, task_id: intent.task_id, task_email: intent.task_email, item: wanted, amount: merchants.quote(a.merchant, wanted) ?? a.amount, booked_at: clock.now() });
          continue;
        }
        if (!dates) continue;
        const from = a.dates?.start ? shortDate(a.dates.start) : null;
        const item = from ? a.summary.replace(new RegExp(`\\b${from}\\b`), shortDate(dates.start)) : a.summary;
        const range = a.category === "hotel" ? { start: dates.start, ...(dates.end ? { end: dates.end } : {}) } : { start: dates.start };
        await merchants.book({ merchant_id: a.merchant, task_id: intent.task_id, task_email: intent.task_email, item, dates: range, amount: a.amount, booked_at: clock.now() });
      }
    };
    run().catch((e) => console.error("[demo-redo] failed:", e instanceof Error ? e.message : e));
  }

  const anthropicKey = cloud ? undefined : env.ANTHROPIC_API_KEY?.trim();
  const captureSide = proxy.deps.demo ? repointDemo(store, proxy, proxy.deps.demo) : { store, hooks: proxy };
  capture = createCapture({
    store: captureSide.store,
    hooks: captureSide.hooks,
    clock,
    // Northwind Market's receipts come from its own domain (capture knows the other mock merchants already).
    senderMerchants: { "northwindmarket.example": "northwind" },
    ...(anthropicKey ? { llm: createAnthropicExtractor({ apiKey: anthropicKey }) } : {}),
  });
  // Every message to the human goes on the alert channel and from Proxy's identity, whatever channel the
  // reply came in on (the demo page's buttons arrive as "sms").
  const sendToHuman = async (body: string) => {
    const task = proxy.deps.demo?.current ?? (await proxy.mostRecentlyAlertedOpenChain())?.task_id;
    if (task) proxy.note({ task_id: task, chain_id: null, actor: "proxy", kind: "text_out", text: body, data: { channel: alertChannel } });
    return humanPhone ? inkbox.sendText(alertChannel, humanNumber, body) : { message_id: "not_sent" };
  };
  const channel = createHumanChannel({
    store,
    hooks: proxy,
    clock,
    sendText: async (_via, _to, body) => sendToHuman(body),
    humanNumber,
  });
  proxy.setHumanChannel(channel);
  const human = frontHumanChannel({ human: channel, proxy, clock, humanNumber, say: sendToHuman });
  const routes = [
    createInboundEmailRoute({ capture, fetchFullMessage }),
    ...createHumanRoutes(human, createVerifier(env)),
    ...merchantRoutes(merchants, merchantDeps, clock),
    ...("recentEvents" in store
      ? createWebRoutes({ store: store as Store & EventReader, clock, channel: human, humanNumber, controls: demoOn && !cloud })
      : []),
  ];

  return { proxy, store, human, capture, routes, fakePayments, merchants };
}

/**
 * Starts Sarah's protocol inbox once, for the server's lifetime. It polls Proxy's A2A tasks and email for the
 * merchant agents' answers and hands each to the current runtime (which /demo/reset replaces). It runs only with
 * a real Inkbox key and no loopback; otherwise the in-process mock agent answers and there is nothing to poll.
 * Restart point: the latest processed merchant message in the Store, minus 2 minutes. The orchestrator drops
 * replays by negotiation, message type, round and amount, so the overlap is safe.
 */
export interface StartedInbox {
  inbox: ProtocolInbox;
  schedule: PollSchedule;
}

export async function startProtocolInbox(
  getRuntime: () => Runtime,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
  access?: A2AAccess,
): Promise<StartedInbox | null> {
  // Dry-run and the cloud judge copy never poll Inkbox; neither does loopback (the in-process mock agent answers instead).
  if (env.INKBOX_DRY_RUN === "1" || isCloud(env)) return null;
  const real = Boolean(env.INKBOX_API_KEY?.trim());
  const loopback = env.PROXY_PROTOCOL_LOOPBACK ? env.PROXY_PROTOCOL_LOOPBACK === "1" : !real;
  if (!real || loopback) return null;
  const rt = getRuntime();
  const handle = env.INKBOX_PROXY_HANDLE?.trim() || "proxy-agent";
  // In-process merchants never send over Inkbox, so nothing from their handle is trusted.
  const identities = rt.merchants.list().flatMap((m) => (m.agent_identity && !rt.merchants.inProcess(m.merchant_id) ? [m.agent_identity] : []));
  const last = await rt.proxy.undo.lastProcessedAt();
  const since = new Date((last ? Date.parse(last) : Date.now()) - 2 * 60_000).toISOString();
  const state = createRateLimitState();
  const log = throttledLog((line) => console.error(`[protocol-inbox] ${line}`));
  const inbox = createProtocolInbox({
    access: guardAccess(access ?? createA2AAccess({ admin: createClient, handle, apiKey: env.INKBOX_PROXY_API_KEY?.trim() || undefined }), state),
    hooks: { onProtocolMessage: (m) => getRuntime().proxy.onProtocolMessage(m) },
    clock,
    store: rt.store,
    trustedHandles: identities,
    trustedEmails: identities.map((i) => `${i}@inkboxmail.com`),
    since,
    // The inbox's own lines about failed polls are throttled with ours; a 429 is reported by the schedule.
    log: (line) => (/rate limit|429/i.test(line) ? undefined : log(line)),
  });
  // Our schedule instead of inbox.start(): one poll at a time, at most every 3 s, backing off on 429.
  const schedule = schedulePolls({ pollOnce: () => inbox.pollOnce(), state, minIntervalMs: Number(env.PROXY_INBOX_POLL_MS ?? 3000), log });
  return { inbox, schedule };
}
