// The human's phone: accepts replies only from the registered number, turns them into HumanReply,
// and calls OrchestratorHooks.onHumanReply once per decision.
import { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "../db/events.js";
import type { ActionId, Chain, ChainId, ChainState, Clock, EventKind, Inkbox, NegotiationId, OrchestratorHooks, Store } from "../types.js";
import { money } from "./alert.js";
import { parseReply } from "./reply.js";

export type Via = "sms" | "imessage";

export type InboundResult =
  | { status: "ignored"; reason: "unregistered_number" | "opt_out" | "no_chain" | "already_asked" }
  | { status: "replied"; reason: string }
  | { status: "forwarded"; kind: "undo_all" | "pick" | "keep" | "counter_decision" };

export interface HumanChannelDeps {
  store: Store;
  hooks: Pick<OrchestratorHooks, "onHumanReply">;
  clock: Clock;
  sendText: Inkbox["sendText"];
  /** The only number whose replies count (E.164). */
  humanNumber: string;
  eventContext?: () => EventContext;
}

const TERMINAL: ChainState[] = ["reversed", "redo_requested", "redone", "closed", "kept", "expired"];
const OPEN: ChainState[] = ["detected", "alerted", "undoing", "partial"];
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

  const log = (kind: EventKind, outcome: string, chain_id: ChainId | null = null) =>
    store.logEvent(makeEvent(ctx(), clock.now(), { kind, outcome, chain_id }));

  /** Tell the channel that a counter question is open, so YES/NO means accept/push back for this chain. */
  function expectCounterDecision(chain_id: ChainId, negotiation_id: NegotiationId) {
    counter.set(chain_id, negotiation_id);
  }

  /** The chain the human is answering: one with an open question first, else the most recently alerted open chain. */
  async function currentChain(): Promise<Chain | null> {
    const chains = await store.listChains();
    const open = chains.filter((c) => OPEN.includes(c.state) || TERMINAL.includes(c.state));
    const lastAlert = (c: Chain) => c.alerts.reduce((t, a) => Math.max(t, Date.parse(a.sent_at)), 0);
    const waiting = open.filter((c) => counter.has(c.chain_id) || picking.has(c.chain_id));
    const pool = waiting.length ? waiting : open.filter((c) => c.alerts.length > 0);
    return pool.sort((a, b) => lastAlert(b) - lastAlert(a))[0] ?? null;
  }

  async function handleInbound(msg: { from: string; body: string; via?: Via }): Promise<InboundResult> {
    const via: Via = msg.via ?? "sms";
    const reply = (text: string) => deps.sendText(via, deps.humanNumber, text);

    if (digits(msg.from) !== registered) {
      // Never reply to a stranger and never echo what they sent.
      await log(via === "imessage" ? "imessage_in" : "sms_in", "ignored:unregistered_number");
      return { status: "ignored", reason: "unregistered_number" };
    }
    const parsed = parseReply(msg.body);
    await log(via === "imessage" ? "imessage_in" : "sms_in", `${via}:${parsed.kind}`);

    if (parsed.kind === "opt_out") return { status: "ignored", reason: "opt_out" };

    const chain = await currentChain();
    if (!chain) {
      await reply("Nothing is waiting on you right now.");
      return { status: "ignored", reason: "no_chain" };
    }
    const id = chain.chain_id;
    const now = clock.now();
    const received_at = now;
    const windowClosed = chain.window_ends_at !== null && Date.parse(now) > Date.parse(chain.window_ends_at);

    if (chain.state === "kept" || decided.get(id) === "keep") {
      await reply("This one is closed as kept. Nothing more will be undone.");
      return { status: "replied", reason: "kept" };
    }
    if (chain.state === "expired" || windowClosed) {
      await reply("Too late for automatic refunds: the window on this closed. Proxy will only try options that still exist, like merchant support or a Stripe dispute, and will text you what happens.");
      await log("sms_out", "too_late", id);
      return { status: "replied", reason: "too_late" };
    }
    if (TERMINAL.includes(chain.state)) {
      await reply("This one is already handled. Nothing more to do.");
      return { status: "replied", reason: "already_handled" };
    }

    // An open counter question takes YES / NO.
    const negotiation = counter.get(id);
    if (negotiation && (parsed.kind === "yes" || parsed.kind === "no")) {
      counter.delete(id);
      await hooks.onHumanReply({ kind: "counter_decision", chain_id: id, negotiation_id: negotiation, accept: parsed.kind === "yes", received_at });
      await reply(parsed.kind === "yes" ? "Accepting the offer." : "Declining the offer.");
      return { status: "forwarded", kind: "counter_decision" };
    }

    if (parsed.kind === "undo_all") {
      if (decided.has(id)) {
        await reply("Already on it. I'll text you as each step is confirmed in Stripe.");
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
        await reply("The undo already started, so I can't keep this. Reply PICK to see what's left.");
        return { status: "replied", reason: "undo_started" };
      }
      decided.set(id, "keep");
      picking.delete(id);
      await hooks.onHumanReply({ kind: "keep", chain_id: id, received_at });
      await reply("Okay, keeping everything. Nothing will be undone.");
      return { status: "forwarded", kind: "keep" };
    }

    if (parsed.kind === "pick" || parsed.kind === "numbers") {
      if (decided.get(id) === "undo_all") {
        await reply("The undo already started for everything.");
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
        await reply(`Got it. Undoing ${picks.join(", ")}. I'll text you as each step is confirmed in Stripe.`);
        return { status: "forwarded", kind: "pick" };
      }
      const lines = await Promise.all(
        items.map(async (actionId, i) => {
          const a = await store.getAction(actionId);
          return `${i + 1}) ${a ? `${a.summary} ${money(a.amount)}` : actionId}`;
        }),
      );
      await reply(`${picks ? "Pick numbers from this list. " : ""}Reply with the numbers to undo, like 1 3:\n${lines.join("\n")}`);
      return { status: "replied", reason: "pick_list" };
    }

    // yes/no with no open question, or anything else.
    if (askedClarify.has(id)) {
      await log("sms_out", "unknown_reply_silent", id);
      return { status: "ignored", reason: "already_asked" };
    }
    askedClarify.add(id);
    await reply("I didn't catch that. Reply UNDO ALL, PICK or KEEP.");
    return { status: "replied", reason: "clarify" };
  }

  return { handleInbound, expectCounterDecision };
}

export type HumanChannel = ReturnType<typeof createHumanChannel>;
