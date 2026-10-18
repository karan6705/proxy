// The human's phone: accepts replies only from the registered number, turns them into HumanReply,
// and calls OrchestratorHooks.onHumanReply once per decision.
import { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "../db/events.js";
import type { ActionId, Chain, ChainId, ChainState, Clock, EventKind, Inkbox, NegotiationId, OrchestratorHooks, Store } from "../types.js";
import { pickLine } from "./alert.js";
import { parseReply } from "./reply.js";

export type Via = "sms" | "imessage";

export type InboundResult =
  | { status: "ignored"; reason: "unregistered_number" | "carrier_keyword" | "no_chain" | "already_asked" | "empty" }
  | { status: "replied"; reason: string }
  | { status: "forwarded"; kind: "undo_all" | "pick" | "keep" | "counter_decision" | "stop" | "correction" };

export interface HumanChannelDeps {
  store: Store;
  hooks: Pick<OrchestratorHooks, "onHumanReply">;
  clock: Clock;
  sendText: Inkbox["sendText"];
  /** The only number whose replies count (E.164). */
  humanNumber: string;
  eventContext?: () => EventContext;
}

/** Chains a reply can still change. Kept and expired chains are never matched by a bare reply. */
const ACTIVE: ChainState[] = ["detected", "alerted", "undoing", "partial"];
/** Finished chains: a late reply still gets an answer, but only when nothing is active. */
const FINISHED: ChainState[] = ["reversed", "redo_requested", "redone", "closed"];
const digits = (n: string) => n.replace(/\D/g, "");

export function createHumanChannel(deps: HumanChannelDeps) {
  const { store, hooks, clock } = deps;
  const ctx = () => (deps.eventContext ?? (() => DEMO_EVENT_CONTEXT))();
  const registered = digits(deps.humanNumber);

  /** Decisions already forwarded, so a second UNDO ALL never starts a second undo. */
  const decided = new Map<ChainId, "undo_all" | "keep" | "pick">();
  const picking = new Map<ChainId, ActionId[]>();
  const counter = new Map<ChainId, NegotiationId>();
  const askedClarify = new Set<ChainId>();
  /** Last correction text forwarded per chain, so a redelivered webhook does not forward it twice. */
  const lastCorrection = new Map<ChainId, string>();

  const log = (kind: EventKind, outcome: string, chain_id: ChainId | null = null) =>
    store.logEvent(makeEvent(ctx(), clock.now(), { kind, outcome, chain_id }));

  /** Tell the channel that a counter question is open, so YES/NO means accept/push back for this chain. */
  function expectCounterDecision(chain_id: ChainId, negotiation_id: NegotiationId) {
    counter.set(chain_id, negotiation_id);
  }

  /**
   * The chain a reply is about. An explicit id (a button on the demo page) wins. Otherwise: a chain with an open
   * question first, then the most recently alerted active chain. Kept and expired chains are left out; finished
   * chains are only used when nothing is active, so a late reply still gets an answer.
   */
  async function currentChain(explicit?: ChainId): Promise<Chain | null> {
    if (explicit) return store.getChain(explicit);
    const chains = (await store.listChains()).filter((c) => c.alerts.length > 0);
    const lastAlert = (c: Chain) => c.alerts.reduce((t, a) => Math.max(t, Date.parse(a.sent_at)), 0);
    const newest = (list: Chain[]) => [...list].sort((a, b) => lastAlert(b) - lastAlert(a))[0] ?? null;
    const active = chains.filter((c) => ACTIVE.includes(c.state));
    const waiting = active.filter((c) => counter.has(c.chain_id) || picking.has(c.chain_id));
    return newest(waiting) ?? newest(active) ?? newest(chains.filter((c) => FINISHED.includes(c.state)));
  }

  async function handleInbound(msg: { from: string; body: string; via?: Via; chain_id?: ChainId }): Promise<InboundResult> {
    const via: Via = msg.via ?? "sms";
    const reply = (text: string) => deps.sendText(via, deps.humanNumber, text);
    const inKind: EventKind = via === "imessage" ? "imessage_in" : "sms_in";

    if (digits(msg.from) !== registered) {
      // Never reply to a stranger and never echo what they sent.
      await log(inKind, "ignored:unregistered_number");
      return { status: "ignored", reason: "unregistered_number" };
    }
    const parsed = parseReply(msg.body);
    await log(inKind, `${via}:${parsed.kind}`);
    const received_at = clock.now();

    if (parsed.kind === "carrier") return { status: "ignored", reason: "carrier_keyword" };

    // STOP freezes all undo activity for this human, whatever chain is open. Over SMS the carrier already answers.
    if (parsed.kind === "stop") {
      await hooks.onHumanReply({ kind: "stop", received_at });
      if (via === "imessage") await reply("Okay, I've paused everything. Nothing will be undone until you reply.\n\nReply UNDO ALL, PICK or KEEP when you're ready.");
      return { status: "forwarded", kind: "stop" };
    }

    const chain = await currentChain(msg.chain_id);
    if (!chain) {
      await reply(msg.chain_id ? "I can't find that one." : "Nothing is waiting on you right now.");
      return { status: "ignored", reason: "no_chain" };
    }
    const id = chain.chain_id;
    const windowClosed = chain.window_ends_at !== null && Date.parse(received_at) > Date.parse(chain.window_ends_at);

    if (chain.state === "kept" || decided.get(id) === "keep") {
      await reply("This one is closed as kept. Nothing more will be undone.");
      return { status: "replied", reason: "kept" };
    }
    if (chain.state === "expired" || windowClosed) {
      await reply("Too late for automatic refunds. That window has closed.\n\nI'll only try what's still possible, like merchant support or a card dispute, and text you what happens.");
      await log("sms_out", "too_late", id);
      return { status: "replied", reason: "too_late" };
    }
    if (!ACTIVE.includes(chain.state)) {
      await reply("This one is already handled. Nothing more to do.");
      return { status: "replied", reason: "already_handled" };
    }

    // An open counter question takes YES / NO.
    const negotiation = counter.get(id);
    if (negotiation && (parsed.kind === "yes" || parsed.kind === "no")) {
      counter.delete(id);
      await hooks.onHumanReply({ kind: "counter_decision", chain_id: id, negotiation_id: negotiation, accept: parsed.kind === "yes", received_at });
      await reply(parsed.kind === "yes" ? "Okay, accepting the offer." : "Okay, declining the offer.");
      return { status: "forwarded", kind: "counter_decision" };
    }

    if (parsed.kind === "undo_all") {
      // A second UNDO ALL is a no-op. After a PICK it is a change of mind, so it goes through.
      if (decided.get(id) === "undo_all") {
        await reply("Already on it. I'll text you as each refund is confirmed.");
        return { status: "replied", reason: "duplicate" };
      }
      decided.set(id, "undo_all");
      picking.delete(id);
      await hooks.onHumanReply({ kind: "undo_all", chain_id: id, received_at });
      await reply("Got it. Starting the undo. I'll text you as each step is confirmed in Stripe.");
      return { status: "forwarded", kind: "undo_all" };
    }

    if (parsed.kind === "keep") {
      if (decided.get(id) === "undo_all") {
        await reply("The undo has already started, so I can't keep this.\n\nReply PICK to see what's left.");
        return { status: "replied", reason: "undo_started" };
      }
      decided.set(id, "keep");
      picking.delete(id);
      await hooks.onHumanReply({ kind: "keep", chain_id: id, received_at });
      await reply("Okay. Keeping everything. Nothing will be undone.");
      return { status: "forwarded", kind: "keep" };
    }

    if (parsed.kind === "pick" || parsed.kind === "numbers") {
      if (decided.get(id) === "undo_all") {
        await reply("The undo has already started for everything.");
        return { status: "replied", reason: "undo_started" };
      }
      let items = picking.get(id);
      if (!items) {
        items = chain.action_ids;
        picking.set(id, items);
      }
      const picks = parsed.picks;
      if (picks && picks.every((n) => n >= 1 && n <= items.length)) {
        picking.delete(id);
        decided.set(id, "pick");
        await hooks.onHumanReply({ kind: "pick", chain_id: id, picks, received_at });
        const which = picks.length === 1 ? `${picks[0]}` : `${picks.slice(0, -1).join(", ")} and ${picks[picks.length - 1]}`;
        await reply(`Got it. Undoing ${which}.\n\nI'll text you as each refund is confirmed in Stripe.`);
        return { status: "forwarded", kind: "pick" };
      }
      const lines = await Promise.all(
        items.map(async (actionId, i) => {
          const a = await store.getAction(actionId);
          return `${i + 1}) ${a ? pickLine(a) : actionId}`;
        }),
      );
      await reply(`${picks ? "Pick from these.\n\n" : ""}Which should I undo?\n\n${lines.join("\n")}\n\nReply with numbers, like 1 3.`);
      return { status: "replied", reason: "pick_list" };
    }

    // A bare YES or NO with no question open: ask once.
    if (parsed.kind === "yes" || parsed.kind === "no") {
      if (askedClarify.has(id)) return { status: "ignored", reason: "already_asked" };
      askedClarify.add(id);
      await reply("I'm not sure what you're answering.\n\nReply UNDO ALL, PICK or KEEP.");
      return { status: "replied", reason: "clarify" };
    }

    // Anything else is the human's own words, such as "ugh no the 13th". Forward them unchanged; the
    // orchestrator confirms once with the human before acting.
    if (!msg.body.trim()) return { status: "ignored", reason: "empty" };
    if (lastCorrection.get(id) === msg.body) return { status: "ignored", reason: "already_asked" };
    lastCorrection.set(id, msg.body);
    await hooks.onHumanReply({ kind: "correction", chain_id: id, corrected_text: msg.body, received_at });
    return { status: "forwarded", kind: "correction" };
  }

  return { handleInbound, expectCounterDecision };
}

export type HumanChannel = ReturnType<typeof createHumanChannel>;
