// Proxy's side of the Reversal Protocol, receiving: merchant answers come in over A2A (the reply on the task
// Proxy opened) or, as the fallback, by email with the same JSON. Only typed fields reach the orchestrator.
import { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "../db/events.js";
import type { Clock, EventKind, MerchantProtocolMessage, OrchestratorHooks, Store } from "../types.js";
import type { A2AAccess } from "./a2a.js";
import { isProtocolSubject, jsonFromParts, parseMerchantMessage } from "./protocol.js";

export interface ProtocolInboxOptions {
  access: A2AAccess;
  hooks: Pick<OrchestratorHooks, "onProtocolMessage">;
  clock: Clock;
  store?: Store;
  eventContext?: () => EventContext;
  /** Merchant identities whose answers count (handles, e.g. "hotel-agent"). Everything else is ignored and logged. */
  trustedHandles: string[];
  /** Same identities by email address, for the fallback. */
  trustedEmails: string[];
  /** Ignore anything created before this (ISO). Default: when the inbox was created, so a restart never replays history. */
  since?: string;
  pollMs?: number;
  log?: (line: string) => void;
}

export function createProtocolInbox(opts: ProtocolInboxOptions) {
  const since = Date.parse(opts.since ?? new Date().toISOString());
  const ctx = () => (opts.eventContext ?? (() => DEMO_EVENT_CONTEXT))();
  const seen = new Set<string>();
  const trustedHandles = new Set(opts.trustedHandles.map((h) => h.toLowerCase()));
  const trustedEmails = new Set(opts.trustedEmails.map((e) => e.toLowerCase()));
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const record = (outcome: string, msg?: MerchantProtocolMessage, kind: EventKind = "a2a") =>
    opts.store?.logEvent(makeEvent(ctx(), opts.clock.now(), { kind, outcome, chain_id: msg?.chain_id ?? null, action_id: msg?.action_id ?? null }));

  async function deliver(raw: unknown, via: "a2a" | "email"): Promise<boolean> {
    const msg = parseMerchantMessage(raw, opts.clock.now());
    if (!msg) {
      await record(`dropped:invalid:${via}`);
      return false;
    }
    await record(`in:${via}:${msg.type}`, msg);
    await opts.hooks.onProtocolMessage(msg);
    return true;
  }

  /** One pass over A2A and email. Returns how many messages reached the orchestrator. */
  async function pollOnce(): Promise<number> {
    let delivered = 0;
    const { identity } = await opts.access.identity();

    // A2A: answers the merchant wrote on tasks Proxy opened.
    try {
      for await (const m of identity.iterA2AMessages({ direction: "outbound", role: "agent" })) {
        if (seen.has(m.id) || Date.parse(m.createdAt) < since) continue;
        seen.add(m.id);
        const from = String(m.target?.handle ?? "").toLowerCase();
        if (!trustedHandles.has(from)) {
          await record("dropped:untrusted_sender:a2a");
          continue;
        }
        if (await deliver(jsonFromParts(m.parts), "a2a")) delivered++;
      }
    } catch (e) {
      log(`a2a poll failed: ${(e as Error).message}`);
    }

    // Email fallback: same JSON, subject "[proxy:<type>] <negotiation_id>".
    try {
      let looked = 0;
      for await (const m of identity.iterEmails()) {
        if (++looked > 40) break;
        if (Date.parse(m.createdAt) < since) break;
        if (seen.has(m.id) || !isProtocolSubject(m.subject)) continue;
        seen.add(m.id);
        if (!trustedEmails.has(String(m.fromAddress).toLowerCase())) {
          await record("dropped:untrusted_sender:email", undefined, "email_in");
          continue;
        }
        const full = await identity.getMessage(m.id);
        if (await deliver(full.bodyText ?? "", "email")) delivered++;
      }
    } catch (e) {
      log(`email poll failed: ${(e as Error).message}`);
    }
    return delivered;
  }

  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        pollOnce().catch((e) => log(`poll failed: ${(e as Error).message}`)).finally(() => (running = false));
      }, opts.pollMs ?? 3000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type ProtocolInbox = ReturnType<typeof createProtocolInbox>;
