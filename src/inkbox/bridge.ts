// The merchant side of the Reversal Protocol for a mock merchant agent (Dhwanil's MerchantAgent.respond).
// Reads Proxy's requests from the merchant's Inkbox identity (A2A task, or email fallback), asks the agent,
// and answers on the same channel. Merchant logic stays in src/merchants; this is only transport.
import { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "../db/events.js";
import type { Clock, MerchantAgent, Store } from "../types.js";
import type { A2AAccess } from "./a2a.js";
import { isProtocolSubject, jsonFromParts, parseProxyMessage, protocolSubject } from "./protocol.js";

export interface MerchantBridgeOptions {
  access: A2AAccess;
  agent: MerchantAgent;
  clock: Clock;
  store?: Store;
  eventContext?: () => EventContext;
  /** Only Proxy may ask. Handle and email address. */
  proxyHandle: string;
  proxyEmail: string;
  since?: string;
  pollMs?: number;
  log?: (line: string) => void;
}

export function createMerchantBridge(opts: MerchantBridgeOptions) {
  const since = Date.parse(opts.since ?? new Date().toISOString());
  const ctx = () => (opts.eventContext ?? (() => DEMO_EVENT_CONTEXT))();
  const seen = new Set<string>();
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const record = (outcome: string, ids: { chain_id?: string; action_id?: string } = {}) =>
    opts.store?.logEvent(makeEvent(ctx(), opts.clock.now(), { kind: "a2a", outcome, ...ids }));

  async function pollOnce(): Promise<number> {
    let answered = 0;
    const { identity } = await opts.access.identity();

    // A2A: for each open task, answer only Proxy's latest message. Earlier ones were already answered, and
    // a closed task (completed, failed, canceled) is never answered again, so a restart cannot replay a negotiation.
    try {
      const latest = new Map<string, Record<string, any>>();
      for await (const m of identity.iterA2AMessages({ direction: "inbound", role: "caller" })) {
        if (Date.parse(m.createdAt) < since) continue;
        const prev = latest.get(m.taskId);
        if (!prev || Date.parse(m.createdAt) >= Date.parse(prev.createdAt)) latest.set(m.taskId, m);
      }
      for (const m of latest.values()) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.taskState && !["submitted", "working"].includes(m.taskState)) continue;
        if (String(m.caller?.handle ?? "").toLowerCase() !== opts.proxyHandle.toLowerCase()) {
          await record("dropped:untrusted_caller");
          continue;
        }
        const request = parseProxyMessage(jsonFromParts(m.parts), opts.clock.now());
        if (!request) {
          await record("dropped:invalid_request");
          continue;
        }
        const reply = await opts.agent.respond(request, opts.clock.now());
        // A counter waits for Proxy's decision on the same task; accept and deny close it.
        await identity.a2aReply(m.taskId, { intent: reply.type === "counter" ? "ask_caller" : "complete", text: JSON.stringify(reply) });
        await record(`answered:a2a:${reply.type}`, { chain_id: request.chain_id, action_id: request.action_id });
        answered++;
      }
    } catch (e) {
      log(`a2a poll failed: ${(e as Error).message}`);
    }

    // Email fallback.
    try {
      let looked = 0;
      for await (const m of identity.iterEmails()) {
        if (++looked > 40) break;
        if (Date.parse(m.createdAt) < since) break;
        if (seen.has(m.id) || !isProtocolSubject(m.subject)) continue;
        seen.add(m.id);
        if (String(m.fromAddress).toLowerCase() !== opts.proxyEmail.toLowerCase()) continue;
        const request = parseProxyMessage((await identity.getMessage(m.id)).bodyText ?? "", opts.clock.now());
        if (!request) continue;
        const reply = await opts.agent.respond(request, opts.clock.now());
        await identity.sendEmail({ to: [opts.proxyEmail], subject: protocolSubject(reply.type, reply.negotiation_id), bodyText: JSON.stringify(reply) });
        await record(`answered:email:${reply.type}`, { chain_id: request.chain_id, action_id: request.action_id });
        answered++;
      }
    } catch (e) {
      log(`email poll failed: ${(e as Error).message}`);
    }
    return answered;
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

export type MerchantBridge = ReturnType<typeof createMerchantBridge>;
