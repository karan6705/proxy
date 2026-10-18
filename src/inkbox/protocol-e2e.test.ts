// The Reversal Protocol through the real Inkbox code paths, over an in-memory Inkbox: Proxy sends with
// createInkbox().sendProtocolMessage, the hotel's side runs createMerchantBridge with the real hotel agent, and
// Proxy reads the answers with createProtocolInbox. Nothing is loopback: every message is JSON on an A2A task
// (or an email), parsed by protocol.ts on the way in, exactly as on Karan's laptop with real keys.
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createSimulatedClock } from "../orchestrator/clock.js";
import { DEFAULT_PARAMS } from "../orchestrator/params.js";
import { createRuntime } from "../orchestrator/runtime.js";
import { createToolHandlers } from "../tools/handlers.js";
import type { Action, MerchantAgent, MerchantProtocolMessage, ProxyProtocolMessage } from "../types.js";
import type { A2AAccess } from "./a2a.js";
import { createInkbox } from "./client.js";
import { createMerchantBridge, createProtocolInbox } from "./index.js";

const HUMAN = "+15555550100";
const PREFS = { no_store_credit: true, min_partial_refund_pct: 80, auto_undo: false };
const LATE = "2026-11-01T20:19:15.000Z"; // the demo's late confirmations; the hotel still negotiates (check-in Nov 3)

interface A2AMsg { id: string; taskId: string; createdAt: string; role: "caller" | "agent"; caller: { handle: string }; target: { handle: string }; parts: { text: string }[] }
interface Mail { id: string; subject: string; fromAddress: string; createdAt: string; bodyText: string }

/** One in-memory Inkbox shared by every identity: A2A tasks and their messages, inboxes, and texts sent. */
function fakeInkbox() {
  let seq = 0;
  const at = () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ++seq * 1000).toISOString();
  const tasks = new Map<string, { state: string; worker: string; caller: string }>();
  const a2a: A2AMsg[] = [];
  const mail = new Map<string, Mail[]>();
  const texts: { to: string; text: string }[] = [];
  const identities = new Map<string, unknown>();

  const identity = (handle: string) => {
    if (identities.has(handle)) return identities.get(handle);
    const address = `${handle}@inkboxmail.com`;
    const me = {
      id: handle,
      emailAddress: address,
      async *iterA2AMessages(o: { direction: string; role: string }) {
        for (const m of [...a2a].reverse()) {
          const t = tasks.get(m.taskId)!;
          // Proxy reads the agent's replies on tasks it opened; the merchant reads callers' messages on its tasks.
          const mine = o.direction === "outbound" ? t.caller === handle && m.role === "agent" : t.worker === handle && m.role === "caller";
          if (mine) yield { ...m, taskState: t.state };
        }
      },
      async a2aReply(taskId: string, r: { intent: string; text: string }) {
        const t = tasks.get(taskId)!;
        a2a.push({ id: `m${++seq}`, taskId, createdAt: at(), role: "agent", caller: { handle: t.caller }, target: { handle }, parts: [{ text: r.text }] });
        t.state = r.intent === "complete" ? "completed" : "input-required";
        return {};
      },
      async a2aClient() {
        return {
          fetchCard: async (url: string) => ({ url }),
          async send(card: { url: string }, o: { text: string; taskId?: string }) {
            const worker = /\/a2a\/([^/]+)\//.exec(card.url)![1]!;
            const taskId = o.taskId ?? `task${++seq}`;
            tasks.set(taskId, { state: "submitted", worker, caller: handle });
            a2a.push({ id: `m${++seq}`, taskId, createdAt: at(), role: "caller", caller: { handle }, target: { handle: worker }, parts: [{ text: o.text }] });
            return { task: { id: taskId } };
          },
        };
      },
      async a2aSentTasks() {
        return { items: [] };
      },
      async *iterEmails() {
        for (const m of [...(mail.get(address) ?? [])].reverse()) yield m;
      },
      async getMessage(id: string) {
        return (mail.get(address) ?? []).find((m) => m.id === id);
      },
      async sendEmail(e: { to: string[]; subject: string; bodyText: string }) {
        for (const to of e.to) mail.set(to, [...(mail.get(to) ?? []), { id: `e${++seq}`, subject: e.subject, fromAddress: address, createdAt: at(), bodyText: e.bodyText }]);
        return { id: `e${seq}` };
      },
      async sendIMessage(t: { to: string; text: string }) {
        texts.push(t);
        return { id: `t${++seq}` };
      },
      async sendText(t: { to: string; text: string }) {
        texts.push(t);
        return { id: `t${++seq}` };
      },
    };
    identities.set(handle, me);
    return me;
  };
  const sdk = {
    getIdentity: async (handle: string) => identity(handle),
    createIdentity: async (handle: string) => identity(handle),
    a2a: { organizationDirectory: async (o: { q: string }) => ({ items: [{ cardUrl: `https://inkbox.test/a2a/${o.q}/card.json` }] }) },
  };
  const access = (handle: string): A2AAccess => ({ identity: async () => ({ inkbox: sdk, identity: identity(handle) }) });
  return { sdk, access, texts, mail, a2a };
}

/** A server with real Inkbox transport (no loopback), a chain of hotel (+ optional transfer), and UNDO ALL sent. */
async function liveChain(opts: { agent?: (real: MerchantAgent) => MerchantAgent; timeoutMs?: number; transfer?: boolean } = {}) {
  const ink = fakeInkbox();
  const clock = createSimulatedClock(LATE);
  const store = createMemoryStore();
  const inkbox = createInkbox({ sdk: async () => ink.sdk, a2a: ink.access("proxy-agent"), dryRun: false, store, clock, log: () => {} });
  const rt = createRuntime(clock, DEFAULT_PARAMS, PREFS, {
    store,
    inkbox,
    env: { HUMAN_PHONE: HUMAN, PROXY_PROTOCOL_LOOPBACK: "0", PROXY_ALERT_SETTLE_MS: "0", PROXY_AGENT_TIMEOUT_MS: String(opts.timeoutMs ?? 60_000) },
  });
  const tools = createToolHandlers(() => rt.proxy);
  const logged = (await tools.log_intent({ goal: "NYC trip for the Nov 13 conference", constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 150_000 }, preferences: PREFS, idempotency_key: "e2e" })).structuredContent;
  if (!logged.ok) throw new Error("log_intent failed");
  const book = async (merchant_id: string, category: Action["category"], amount: number, dates: Action["dates"], item: string) => {
    const b = await rt.merchants.book({ merchant_id, task_id: logged.task_id, task_email: logged.task_email, item, dates, amount, booked_at: clock.now(), defer_confirmation: true });
    // The same action id capture gives a confirmation, so the simulated payments find the booking's charge.
    const action: Action = { action_id: `act_${logged.task_id}_${b.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, task_id: logged.task_id, merchant: merchant_id, category, summary: item, amount, dates, ref: b.ref, source: "email", received_at: clock.now(), state: "found" };
    await rt.proxy.onAction(action);
    return action;
  };
  rt.proxy.deps.sessions.end(logged.task_id);
  const hotel = await book("hotel", "hotel", 64_000, { start: "2026-11-03", end: "2026-11-06" }, "Hotel, 3 nights");
  const transfer = opts.transfer ? await book("transfer", "transfer", 18_800, { start: "2026-11-03" }, "Airport transfer, Nov 3") : null;
  await rt.proxy.alertChains(logged.task_id);
  const [chain] = await rt.store.listChains(logged.task_id);

  const realAgent = rt.merchants.agent("hotel")!;
  const since = "2000-01-01T00:00:00.000Z";
  const bridge = createMerchantBridge({ access: ink.access("hotel-agent"), agent: opts.agent ? opts.agent(realAgent) : realAgent, clock, proxyHandle: "proxy-agent", proxyEmail: "proxy-agent@inkboxmail.com", since });
  const inbox = createProtocolInbox({ access: ink.access("proxy-agent"), hooks: rt.proxy, clock, store, trustedHandles: ["hotel-agent"], trustedEmails: ["hotel-agent@inkboxmail.com"], since });
  await rt.human.handleInbound({ from: HUMAN, body: "UNDO ALL", via: "imessage" });

  /**
   * Both sides poll, like the 3 s timers on the laptop, until `done` or about 3 s pass. Proxy asks before accepting
   * any offer; the human answers `choose` (default 1, the recommendation) to each new options text, unless null.
   */
  let answered = 0;
  const pump = async (done: () => Promise<boolean>, merchantAnswers = true, choose: string | null = "1") => {
    for (let i = 0; i < 300 && !(await done()); i++) {
      if (merchantAnswers) await bridge.pollOnce();
      await inbox.pollOnce();
      const asked = ink.texts.filter((t) => /best offer:/.test(t.text) && !/^Still waiting/.test(t.text)).length;
      if (choose && asked > answered) {
        answered = asked;
        await rt.human.handleInbound({ from: HUMAN, body: choose, via: "imessage" });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const state = async (a: Action) => (await rt.store.getAction(a.action_id))?.state;
  const texts = () => ink.texts.map((t) => t.text);
  return { ink, rt, chain: chain!, hotel, transfer, pump, state, texts };
}

const typeOf = (m: { parts: { text: string }[] }) => {
  const o = JSON.parse(m.parts[0]!.text) as ProxyProtocolMessage | MerchantProtocolMessage;
  return `${o.type}${"kind" in o ? `:${o.kind}` : ""}@${o.round}`;
};

describe("the Reversal Protocol over Inkbox (real inbox, bridge and client code)", () => {
  it("runs the whole four-round demo and ends with $544 verified", async () => {
    const s = await liveChain();
    await s.pump(async () => (await s.state(s.hotel)) === "verified");

    expect(s.ink.a2a.map(typeOf)).toEqual([
      "request_reversal@1",
      "counter:store_credit@1",
      "push_back@2",
      "counter:partial_refund@2",
      "push_back@3",
      "counter:partial_refund@3",
      "accept_counter@4",
      "accept@4",
    ]);
    expect(await s.state(s.hotel)).toBe("verified");
    expect(s.rt.fakePayments?.refunds.size).toBe(1);
    expect(s.texts()).toContain("Proxy negotiated with the hotel's agent. Hotel refunded, $544 of $640, confirmed in Stripe.");
    // The hotel's own words arrived for display, and nothing was dropped on either side.
    const said = s.rt.proxy.feed.list(s.chain.task_id).filter((e) => e.kind === "protocol_in").map((e) => e.data.said);
    expect(said.at(-2)).toBe("85% ($544.00) is our final offer.");
    expect((s.rt.store as unknown as { events(): { outcome: string | null }[] }).events().some((e) => e.outcome?.startsWith("dropped"))).toBe(false);
  });

  it("an acceptable counter past the round limit texts the human, and their YES completes it", async () => {
    // A merchant that answers the first request with 85% in "round 4": accepting would be round 5, past the limit.
    const s = await liveChain({
      agent: (real) => ({
        merchant_id: "hotel",
        async respond(message, now) {
          if (message.type === "request_reversal") {
            return { negotiation_id: message.negotiation_id, chain_id: message.chain_id, action_id: message.action_id, round: 4, sent_at: now, type: "counter", kind: "partial_refund", amount: 54_400 };
          }
          if (message.type === "accept_counter") {
            await real.respond({ ...message, type: "request_reversal" } as never, now).catch(() => undefined);
            return { negotiation_id: message.negotiation_id, chain_id: message.chain_id, action_id: message.action_id, round: message.round, sent_at: now, type: "accept", refund_amount: 54_400 };
          }
          throw new Error(`unexpected ${message.type}`);
        },
      }),
    });
    await s.pump(async () => s.texts().some((t) => /best offer:/.test(t)), true, null);
    expect(s.texts()).toContain("Harborview Hotel's best offer:\n1) Refund $544 (85%) to your card\nYour rules prefer refunds, so I recommend 1. Reply 1.");
    expect(await s.state(s.hotel)).toBe("countered");

    await s.rt.human.handleInbound({ from: HUMAN, body: "YES", via: "imessage" });
    await s.pump(async () => (await s.state(s.hotel)) === "verified", true, null);
    expect(await s.state(s.hotel)).toBe("verified");
    expect(s.ink.a2a.map(typeOf).at(-2)).toBe("accept_counter@4");
  });

  it("a merchant that stops answering never leaves the chain silent: a text, an email follow-up, then the summary", async () => {
    const s = await liveChain({ transfer: true, timeoutMs: 40 });
    // The hotel's bridge is down: nothing answers on A2A or email.
    await s.pump(async () => s.chain && (await s.rt.store.getChain(s.chain.chain_id))?.state === "partial", false);

    expect(await s.state(s.transfer!)).toBe("verified"); // the rest finished meanwhile
    expect(s.texts()).toContain("The hotel hasn't answered, following up by email.");
    const followUp = (s.ink.mail.get("hotel-agent@inkboxmail.com") ?? []).find((m) => m.subject.startsWith("[proxy:request_reversal]"));
    expect(followUp).toBeDefined();
    expect(s.texts()).toContain("The hotel never answered, by its agent or by email.");
    expect((await s.rt.store.getChain(s.chain.chain_id))?.state).toBe("partial");
    expect(s.texts().at(-1)).toMatch(/^Partly done\./);
  });

  it("a step that stalls where no protocol timer covers it (a refund Stripe never confirms) still texts the human, then finishes", async () => {
    const s = await liveChain({ timeoutMs: 30 });
    // Stripe accepts the refund but never shows it: the hotel step sits in refund_pending with nothing left to wait on.
    const pay = s.rt.proxy.deps.payments;
    pay.refund = async () => ({ refund_id: "re_never_settles" });
    await s.pump(async () => (await s.rt.store.getChain(s.chain.chain_id))?.state === "partial");

    expect(s.texts()).toContain("Still working on the hotel. Everything else is settled. I'll text you as soon as it's done.");
    expect((await s.rt.store.getChain(s.chain.chain_id))?.state).toBe("partial");
    expect(s.texts().at(-1)).toMatch(/^Partly done\./);
  });
});
