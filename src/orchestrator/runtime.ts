// Builds the server's orchestrator from what is available: Sarah's Store (Supabase from env, else in
// memory), capture and human channel; her Inkbox client when INKBOX_API_KEY or INKBOX_DRY_RUN is set;
// real Stripe test mode when a sk_test_ key is set. Logic and Merchants stay stand-ins until Dhwanil's merge.
import { createAnthropicExtractor, createCapture, createInboundEmailRoute, deliverToCapture, type Capture } from "../capture/index.js";
import { createStoreFromEnv } from "../db/index.js";
import { createClient, createHumanChannel, createHumanRoutes, createInkbox, type HumanChannel } from "../inkbox/index.js";
import { logic } from "../logic/index.js";
import {
  addressMode,
  createInkboxDeliver,
  createMerchants,
  merchantRoutes,
  type MerchantDeps,
  type MerchantsImpl,
} from "../merchants/index.js";
import { createPayments, createTestCharge } from "../stripe/index.js";
import type { Action, Clock, Inkbox, OrchestratorHooks, Params, Payments, Preferences, RouteHandler, Store, TaskId } from "../types.js";
import { createFakePayments } from "./fakes.js";
import { createProxy, type DemoTask, type Proxy } from "./proxy.js";
import { createSessions } from "./sessions.js";
import { createStandInInkbox } from "./standin-inkbox.js";

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

export function createRuntime(clock: Clock, params: Params, defaultPreferences: Preferences, overrides: RuntimeOverrides = {}): Runtime {
  const env = overrides.env ?? process.env;
  const store = overrides.store ?? createStoreFromEnv(env);
  const useInkbox = Boolean(env.INKBOX_API_KEY?.trim()) || env.INKBOX_DRY_RUN === "1";
  const inkbox = overrides.inkbox ?? (useInkbox ? createInkbox({ store, clock }) : createStandInInkbox());
  const useStripe = (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
  const fakePayments = useStripe ? null : createFakePayments();
  const fakeChargesByKey = new Map<string, string>();
  let fakeChargeSequence = 0;
  let capture: Capture | null = null;
  const mode = addressMode(env);
  const liveDeliver = mode === "real" ? createInkboxDeliver({ env }) : null;
  // Charge ids by action, remembered when the merchant charges. Stripe's search is eventually consistent,
  // so a refund right after a booking can't rely on it alone; the search stays as the fallback.
  const chargeByAction = new Map<string, string>();
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
        args.idempotency_key,
      );
      chargeByAction.set(action_id, result.charge_id);
      return { charge_id: result.charge_id };
    },
    async deliver(email) {
      if (liveDeliver) return liveDeliver(email);
      if (!capture) throw new Error("Capture is not ready for merchant email delivery");
      return deliverToCapture(capture)(email);
    },
  };
  const merchants = createMerchants(merchantDeps, { addresses: mode });

  const proxy = createProxy({
    store,
    logic,
    inkbox,
    payments: withKnownCharges(fakePayments ? fakePayments.payments : createPayments(), chargeByAction),
    merchants,
    sessions: createSessions(clock, params.SESSION_IDLE_MS),
    clock,
    params,
    defaultPreferences,
    demo: env.PROXY_DEMO_ROUTES === "1" ? { identityTaskId: env.INKBOX_DEMO_TASK_ID?.trim() || "task_demo", current: null } : null,
    humanNumber: env.HUMAN_PHONE?.trim() ?? "",
  });

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const captureSide = proxy.deps.demo ? repointDemo(store, proxy, proxy.deps.demo) : { store, hooks: proxy };
  capture = createCapture({
    store: captureSide.store,
    hooks: captureSide.hooks,
    clock,
    ...(anthropicKey ? { llm: createAnthropicExtractor({ apiKey: anthropicKey }) } : {}),
  });
  const human = createHumanChannel({
    store,
    hooks: proxy,
    clock,
    sendText: (channel, to, body) => inkbox.sendText(channel, to, body),
    humanNumber: env.HUMAN_PHONE?.trim() ?? "",
  });
  proxy.setHumanChannel(human);
  const routes = [
    createInboundEmailRoute({ capture, fetchFullMessage }),
    ...createHumanRoutes(human),
    ...merchantRoutes(merchants, merchantDeps, clock),
  ];

  return { proxy, store, human, capture, routes, fakePayments, merchants };
}
