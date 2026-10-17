// Stand-in Logic, used until Dhwanil's src/logic/ merges. Covers the demo scenario only:
// wrong dates, over budget and duplicates; one chain per task; demo reversibility windows.
import type {
  Action,
  ActionId,
  Chain,
  Logic,
  Mismatch,
  PlanStep,
  Reversibility,
  RouteKind,
  Timestamp,
} from "../types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const ROUTE_BY_CATEGORY: Record<Action["category"], RouteKind> = {
  flight: "self_serve",
  hotel: "reversal_protocol",
  transfer: "email_support",
  saas: "email_support",
  store: "email_support",
  message: "correction",
};

/** `minHours` is MIN_HOURS for rank. */
export function createStandInLogic(minHours: number): Logic {
  const reversibility = (action: Action, _now: Timestamp): Reversibility => {
    const got = Date.parse(action.received_at);
    switch (action.category) {
      case "flight":
        return { kind: "cancel_refund", window_ends_at: iso(got + DAY), refundable: true, cost_to_reverse: 0, rule: "24-hour rule: full refund within 24 hours of booking if booked at least 7 days out" };
      case "hotel":
        // Demo value: free cancellation closes 3h 40m after booking, the tightest window in the demo.
        return { kind: "cancel_refund", window_ends_at: iso(got + 220 * MINUTE), refundable: true, cost_to_reverse: 0, rule: "Free cancellation until the hotel's deadline" };
      case "transfer": {
        const pickup = action.dates ? Date.parse(action.dates.start) : got + DAY;
        return { kind: "cancel_refund", window_ends_at: iso(pickup - 2 * HOUR), refundable: true, cost_to_reverse: 0, rule: "Free to cancel until 2 hours before pickup" };
      }
      case "saas":
        return { kind: "cancel_refund", window_ends_at: iso(got + 14 * DAY), refundable: true, cost_to_reverse: 0, rule: "Refund within the vendor's 14-day window" };
      case "store":
        return { kind: "return", window_ends_at: iso(got + 30 * DAY), refundable: true, cost_to_reverse: 0, rule: "Return within 30 days" };
      case "message":
        return { kind: "correct_message", window_ends_at: null, refundable: false, cost_to_reverse: 0, rule: "Send a correction immediately" };
    }
  };

  return {
    compare(intent, actions) {
      const out: Mismatch[] = [];
      const want = intent.constraints.dates;
      const seen = new Map<string, ActionId>();
      let spent = 0;
      const ordered = [...actions].sort((a, b) => a.received_at.localeCompare(b.received_at));
      for (const a of ordered) {
        if (want && a.dates) {
          const end = want.end ?? want.start;
          if (a.dates.start < want.start || a.dates.start > end) {
            out.push({
              action_id: a.action_id,
              field: "dates",
              expected: want.start,
              actual: a.dates.start,
              evidence: { source_action_id: a.action_id, receipt_fields: { summary: a.summary, start_date: a.dates.start } },
            });
          }
        }
        const key = `${a.merchant}|${a.category}|${a.dates?.start ?? ""}`;
        if (a.category !== "message" && seen.has(key)) {
          out.push({ action_id: a.action_id, field: "duplicate", expected: null, actual: seen.get(key) ?? null });
        } else {
          seen.set(key, a.action_id);
        }
        spent += a.amount;
        const budget = intent.constraints.budget_total;
        if (budget !== undefined && spent > budget && spent - a.amount <= budget) {
          out.push({ action_id: a.action_id, field: "amount", expected: budget, actual: spent });
        }
      }
      return out;
    },

    trace(intent, actions, mismatches) {
      if (mismatches.length === 0) return [];
      const ids = new Set(mismatches.map((m) => m.action_id));
      const members = actions
        .filter((a) => ids.has(a.action_id))
        .sort((a, b) => a.received_at.localeCompare(b.received_at));
      // Root: the earliest booked action with a mismatch; a message only if nothing was booked.
      const root = members.find((a) => a.category !== "message") ?? members[0];
      if (!root) return [];
      const chain: Chain = {
        chain_id: `chain_${intent.task_id}`,
        task_id: intent.task_id,
        root_action_id: root.action_id,
        action_ids: members.map((a) => a.action_id),
        money_at_risk: members.reduce((s, a) => s + a.amount, 0),
        window_ends_at: null,
        state: "detected",
        alerts: [],
        plan: [],
        steps: [],
      };
      return [chain];
    },

    reversibility,

    plan_undo(chain, actions, _preferences, now) {
      const steps: PlanStep[] = [];
      const byId = new Map(actions.map((a) => [a.action_id, a]));
      for (const id of chain.action_ids) {
        const a = byId.get(id);
        if (!a) continue;
        const r = reversibility(a, now);
        steps.push({ action_id: id, route: ROUTE_BY_CATEGORY[a.category], option: "cancel", cost: r.cost_to_reverse, deadline: r.window_ends_at });
      }
      // Most urgent first; actions with no window last.
      return steps.sort((x, y) => (x.deadline ?? "9999").localeCompare(y.deadline ?? "9999"));
    },

    rank(chains, now) {
      const score = (c: Chain) => {
        const hoursLeft = c.window_ends_at ? (Date.parse(c.window_ends_at) - Date.parse(now)) / HOUR : Infinity;
        return c.money_at_risk / Math.max(hoursLeft, minHours);
      };
      return [...chains].sort((a, b) => score(b) - score(a));
    },

    negotiate_step(state, message, preferences) {
      // Reads only typed fields. Free text such as DenyMsg.reason is never interpreted.
      const next = { ...state };
      if (message.type === "accept") {
        next.state = "refund_pending";
        return { next_state: next };
      }
      if (message.type === "deny") {
        next.state = "failed";
        return { next_state: next };
      }
      next.last_counter = { kind: message.kind, amount: message.amount };
      const envelope = { negotiation_id: state.negotiation_id, chain_id: state.chain_id, action_id: state.action_id, round: state.round + 1, sent_at: message.sent_at };
      const pct = state.order_amount > 0 ? (message.amount / state.order_amount) * 100 : 0;
      const acceptable =
        message.kind === "partial_refund" ? pct >= preferences.min_partial_refund_pct : message.kind === "store_credit" ? !preferences.no_store_credit : false;
      if (acceptable) {
        next.state = "refund_pending";
        return { next_state: next, outgoing: { ...envelope, type: "accept_counter" } };
      }
      if (state.push_backs_used < 1) {
        next.state = "pushed_back";
        next.push_backs_used += 1;
        next.round += 1;
        return { next_state: next, outgoing: { ...envelope, type: "push_back", reason: "This does not meet the customer's refund preferences." } };
      }
      next.state = "human_decision";
      return { next_state: next, outgoing: { ...envelope, type: "ask_human", counter: { kind: message.kind, amount: message.amount } } };
    },
  };
}
