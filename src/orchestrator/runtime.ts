// Builds the server's orchestrator from whatever is available: stand-ins for Store, Logic, Inkbox and
// Merchants until Sarah's and Dhwanil's code merges; real Stripe test mode when a sk_test_ key is set.
import { createPayments } from "../stripe/index.js";
import type { Clock, Params, Preferences } from "../types.js";
import { createFakePayments, createStubMerchants } from "./fakes.js";
import { createMemoryStore, type MemoryStore } from "./memory-store.js";
import { createProxy, type Proxy } from "./proxy.js";
import { createSessions } from "./sessions.js";
import { createStandInInkbox } from "./standin-inkbox.js";
import { createStandInLogic } from "./standin-logic.js";

export interface Runtime {
  proxy: Proxy;
  store: MemoryStore;
  /** Present when payments are faked (no sk_test_ key); demo routes register charges here. */
  fakePayments: ReturnType<typeof createFakePayments> | null;
  merchants: ReturnType<typeof createStubMerchants>;
}

export function createRuntime(clock: Clock, params: Params, defaultPreferences: Preferences): Runtime {
  const store = createMemoryStore();
  const logic = createStandInLogic(params.MIN_HOURS);
  const useStripe = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
  const fakePayments = useStripe ? null : createFakePayments();
  const merchants = createStubMerchants();
  const proxy = createProxy({
    store,
    logic,
    inkbox: createStandInInkbox(),
    payments: fakePayments ? fakePayments.payments : createPayments(),
    merchants,
    sessions: createSessions(clock, params.SESSION_IDLE_MS),
    clock,
    params,
    defaultPreferences,
  });
  return { proxy, store, fakePayments, merchants };
}
