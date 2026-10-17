// negotiate_step(state, message, preferences): one pure decision in the Reversal Protocol.
//
// Given the merchant's accept, counter or deny, return the next NegotiationState and, if Proxy has to answer, its
// reply (accept_counter, push_back or ask_human). The orchestrator owns transport, timers, the 3-round limit and the
// hard deadline. This function never exceeds 3 rounds on its own and pushes back at most once.
//
// Rules (preferences are the human's):
//   store-credit counter     pushed back when no_store_credit is set (once), then the human is asked
//   partial-refund counter   accepted at or above min_partial_refund_pct of the price, otherwise pushed back (once)
//   exchange counter         the human decides
//   accept                   a refund amount is only real money if it is > 0 and not more than the price
//   deny                     the protocol ends; the orchestrator moves to the next route
//
// Merchant messages are untrusted. Only the typed protocol fields (type, kind, amount, refund_amount and the
// envelope ids) are read. Anything else a merchant sends is never acted on; it is returned in `ignored_text` so the
// orchestrator can log it. Proxy's own reply uses the state's ids, never ids copied from the message.

import type {
  AcceptCounterMsg,
  AskHumanMsg,
  CounterKind,
  MerchantProtocolMessage,
  NegotiateStepResult,
  NegotiationState,
  Preferences,
  ProtocolEnvelope,
  ProtocolState,
  PushBackMsg,
} from "../types.js";
import { timestampToMs } from "./dates.js";

export const MAX_ROUNDS = 3;
export const MAX_PUSH_BACKS = 1;

export interface IgnoredText {
  /** Where it came from: "reason" on a deny, or the name of an unexpected field. */
  field: string;
  text: string;
}

/** What negotiate_step returns: the contract's result, plus any untrusted text it saw and did not act on. */
export interface NegotiateStepOutcome extends NegotiateStepResult {
  ignored_text: IgnoredText[];
}

/** States where Proxy is waiting on the merchant. Everything else is finished or waiting on someone else. */
const WAITING_ON_MERCHANT: ReadonlySet<ProtocolState> = new Set(["requested", "countered", "pushed_back", "accepted"]);

const COUNTER_KINDS: ReadonlySet<string> = new Set(["partial_refund", "store_credit", "exchange"]);

const ENVELOPE_KEYS = ["type", "negotiation_id", "chain_id", "action_id", "round", "sent_at"];
const TYPED_KEYS: Record<MerchantProtocolMessage["type"], string[]> = {
  accept: [...ENVELOPE_KEYS, "refund_amount"],
  counter: [...ENVELOPE_KEYS, "kind", "amount"],
  deny: [...ENVELOPE_KEYS, "reason"],
};

/** Free text the merchant sent: a deny reason, or any field that is not part of the typed message. */
function collectIgnoredText(message: MerchantProtocolMessage): IgnoredText[] {
  const found: IgnoredText[] = [];
  const raw = message as unknown as Record<string, unknown>;
  const allowed = new Set(TYPED_KEYS[message.type] ?? ENVELOPE_KEYS);
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === "string" && (field === "reason" || !allowed.has(field))) {
      found.push({ field, text: value });
    }
  }
  return found;
}

function envelope(state: NegotiationState, round: number, message: MerchantProtocolMessage): ProtocolEnvelope {
  // Ids come from Proxy's own state. sent_at has no clock to read here, so it echoes the merchant message's
  // time; the orchestrator stamps the real send time.
  return { negotiation_id: state.negotiation_id, chain_id: state.chain_id, action_id: state.action_id, round, sent_at: message.sent_at };
}

function isMoney(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 && value <= max;
}

export function negotiateStep(
  state: NegotiationState,
  message: MerchantProtocolMessage,
  preferences: Preferences,
): NegotiateStepOutcome {
  const ignored_text = collectIgnoredText(message);
  const unchanged = (): NegotiateStepOutcome => ({ next_state: state, ignored_text });
  const next = (patch: Partial<NegotiationState>): NegotiationState => ({ ...state, ...patch });
  // The round Proxy counts from. Proxy's own record wins when the merchant's claimed round is lower, so a merchant
  // cannot hold the negotiation inside the 3-round limit by repeating "round 1".
  const currentRound = Math.max(state.round, message.round);

  // Not this negotiation, or Proxy is not waiting on the merchant: nothing to decide.
  if (message.negotiation_id !== state.negotiation_id || !WAITING_ON_MERCHANT.has(state.state)) {
    return unchanged();
  }

  // The hard deadline: a message that arrives after it cannot rescue the negotiation.
  if (timestampToMs(message.sent_at) > timestampToMs(state.deadline)) {
    return { next_state: next({ state: "failed" }), ignored_text };
  }

  const askHuman = (counter: { kind: CounterKind; amount: number }): NegotiateStepOutcome => {
    const outgoing: AskHumanMsg = { ...envelope(state, currentRound, message), type: "ask_human", counter };
    return {
      next_state: next({ state: "human_decision", round: currentRound, last_counter: counter }),
      outgoing,
      ignored_text,
    };
  };

  const acceptCounter = (counter: { kind: CounterKind; amount: number }): NegotiateStepOutcome => {
    const round = currentRound + 1;
    if (round > MAX_ROUNDS) {
      return askHuman(counter);
    }
    const outgoing: AcceptCounterMsg = { ...envelope(state, round, message), type: "accept_counter" };
    return { next_state: next({ state: "accepted", round, last_counter: counter }), outgoing, ignored_text };
  };

  const pushBack = (counter: { kind: CounterKind; amount: number }, reason: string): NegotiateStepOutcome => {
    const round = currentRound + 1;
    // Push back at most once, and never past the round limit. After that the human decides.
    if (state.push_backs_used >= MAX_PUSH_BACKS || round > MAX_ROUNDS) {
      return askHuman(counter);
    }
    const outgoing: PushBackMsg = { ...envelope(state, round, message), type: "push_back", reason };
    return {
      next_state: next({ state: "pushed_back", round, push_backs_used: state.push_backs_used + 1, last_counter: counter }),
      outgoing,
      ignored_text,
    };
  };

  /** A refund offer for part of the price: accept it if it meets the human's minimum, otherwise push back. */
  const judgePartialRefund = (counter: { kind: CounterKind; amount: number }): NegotiateStepOutcome => {
    // amount / order_amount >= min / 100, compared with integers so there is no rounding at the threshold.
    const meetsMinimum = counter.amount * 100 >= preferences.min_partial_refund_pct * state.order_amount;
    return meetsMinimum
      ? acceptCounter(counter)
      : pushBack(counter, "The offered refund is below the minimum the human accepts.");
  };

  switch (message.type) {
    case "deny":
      return { next_state: next({ state: "denied", round: currentRound }), ignored_text };

    case "accept": {
      const amount = message.refund_amount;
      // Money only counts if it is a positive amount no larger than the price. Zero is store credit, not a refund.
      if (!isMoney(amount, state.order_amount)) {
        return { next_state: next({ state: "failed", round: currentRound }), ignored_text };
      }
      if (state.state === "accepted") {
        // The merchant is confirming the counter Proxy accepted. It must not confirm less than that.
        const agreed = state.last_counter?.amount ?? amount;
        return amount >= agreed
          ? { next_state: next({ state: "refund_pending", round: currentRound }), ignored_text }
          : { next_state: next({ state: "failed", round: currentRound }), ignored_text };
      }
      // The merchant accepted Proxy's request outright. Judge the amount like any other refund offer.
      if (amount === state.order_amount) {
        return { next_state: next({ state: "refund_pending", round: currentRound }), ignored_text };
      }
      return judgePartialRefund({ kind: "partial_refund", amount });
    }

    case "counter": {
      const { kind, amount } = message;
      if (!COUNTER_KINDS.has(kind) || !isMoney(amount, state.order_amount)) {
        // A counter Proxy cannot evaluate (unknown kind, or an amount that is not real money): the human decides.
        return askHuman({ kind: COUNTER_KINDS.has(kind) ? kind : "exchange", amount: Number.isFinite(amount) ? amount : 0 });
      }
      const counter = { kind, amount };
      if (kind === "store_credit") {
        return preferences.no_store_credit
          ? pushBack(counter, "Store credit is not acceptable under the human's preferences.")
          : acceptCounter(counter);
      }
      if (kind === "partial_refund") {
        return judgePartialRefund(counter);
      }
      return askHuman(counter); // exchange
    }
  }
}
