// Builds the server's orchestrator from what is available: Sarah's Store (Supabase from env, else in
// memory), capture and human channel; her Inkbox client when INKBOX_API_KEY or INKBOX_DRY_RUN is set;
// real Stripe test mode when a sk_test_ key is set. Logic and Merchants stay stand-ins until Dhwanil's merge.
import { createAnthropicExtractor, createCapture, createInboundEmailRoute } from "../capture/index.js";
import { createStoreFromEnv } from "../db/index.js";
import { createClient, createHumanChannel, createHumanRoutes, createInkbox, type HumanChannel } from "../inkbox/index.js";
import { createPayments } from "../stripe/index.js";
import type { Clock, Inkbox, Params, Preferences, RouteHandler, Store } from "../types.js";
import { createFakePayments, createStubMerchants } from "./fakes.js";
import { createProxy, type Proxy } from "./proxy.js";
import { createSessions } from "./sessions.js";
import { createStandInInkbox } from "./standin-inkbox.js";
import { createStandInLogic } from "./standin-logic.js";

export interface Runtime {
  proxy: Proxy;
  store: Store;
  human: HumanChannel;
  /** Sarah's webhooks: /inkbox/inbound, /inkbox/text, /inkbox/imessage. */
  routes: RouteHandler[];
  /** Present when payments are faked (no sk_test_ key); demo routes register charges here. */
  fakePayments: ReturnType<typeof createFakePayments> | null;
  merchants: ReturnType<typeof createStubMerchants>;
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

export function createRuntime(clock: Clock, params: Params, defaultPreferences: Preferences, overrides: RuntimeOverrides = {}): Runtime {
  const env = overrides.env ?? process.env;
  const store = overrides.store ?? createStoreFromEnv(env);
  const useInkbox = Boolean(env.INKBOX_API_KEY?.trim()) || env.INKBOX_DRY_RUN === "1";
  const inkbox = overrides.inkbox ?? (useInkbox ? createInkbox({ store, clock }) : createStandInInkbox());
  const useStripe = (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
  const fakePayments = useStripe ? null : createFakePayments();
  const merchants = createStubMerchants();

  const proxy = createProxy({
    store,
    logic: createStandInLogic(params.MIN_HOURS),
    inkbox,
    payments: fakePayments ? fakePayments.payments : createPayments(),
    merchants,
    sessions: createSessions(clock, params.SESSION_IDLE_MS),
    clock,
    params,
    defaultPreferences,
    demoTaskId: env.PROXY_DEMO_ROUTES === "1" ? (env.INKBOX_DEMO_TASK_ID?.trim() || "task_demo") : null,
    humanNumber: env.HUMAN_PHONE?.trim() ?? "",
  });

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const capture = createCapture({
    store,
    hooks: proxy,
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
  const routes = [createInboundEmailRoute({ capture, fetchFullMessage }), ...createHumanRoutes(human)];

  return { proxy, store, human, routes, fakePayments, merchants };
}
