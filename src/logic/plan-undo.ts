// plan_undo(chain, actions, preferences, now): route selection and the damage minimizer.
//
// For each action in the chain it picks a route, a fix option, what the fix costs the human, and the latest time it
// can still succeed. Cheapest fix wins; if nothing beats leaving it alone, the option is "keep" (accept the loss).
// Steps come back most urgent first: fixable steps by deadline then cost, steps with no deadline after them, and
// "keep" steps last.
//
// How a step is chosen, from reversibility(action, now) and the rules table (keyed by merchant, then category):
//   cancel_refund      route from the table, option "cancel", cost 0 (the cost of trying), deadline = the window
//   return, no fee     route from the table, option "cancel", cost 0
//   change / return    the window has closed on the cheap fix and only a fee fix is left. Take it only when the fee is
//   with a fee         strictly less than the money lost by keeping (the action's amount); otherwise "keep"
//   correct_message    route "correction", option "change", cost 0
//   none               nothing is reversible any more: "keep", cost = the amount, route "stripe_dispute" as the
//                      last resort the orchestrator may still try
//
// Negotiation preferences (no store credit, minimum partial refund) are applied one step at a time by
// negotiate_step, so `preferences` does not change the plan. It is in the signature because the contract has it.

import type { Action, ActionId, ActionState, Chain, PlanStep, Preferences, Timestamp } from "../types.js";
import { timestampToMs } from "./dates.js";
import { reversibility } from "./reversibility.js";
import { getRule, ruleKeyForAction } from "./rules-table.js";

/** Actions already refunded or deliberately kept need no more planning. */
const SETTLED_STATES: ReadonlySet<ActionState> = new Set(["verified", "kept"]);

function keep(action: Action): PlanStep {
  return { action_id: action.action_id, route: "stripe_dispute", option: "keep", cost: action.amount, deadline: null };
}

function stepFor(action: Action, now: Timestamp): PlanStep {
  const rev = reversibility(action, now);
  const rule = getRule(ruleKeyForAction(action));

  switch (rev.kind) {
    case "correct_message":
      return { action_id: action.action_id, route: "correction", option: "change", cost: rev.cost_to_reverse, deadline: rev.window_ends_at };

    case "cancel_refund":
      return { action_id: action.action_id, route: rule.route, option: "cancel", cost: rev.cost_to_reverse, deadline: rev.window_ends_at };

    case "return":
    case "change": {
      if (rev.kind === "return" && rev.cost_to_reverse === 0) {
        return { action_id: action.action_id, route: rule.route, option: "cancel", cost: 0, deadline: rev.window_ends_at };
      }
      // Only a fee fix is left. Worth it only if the fee is strictly less than the loss from keeping.
      if (rev.cost_to_reverse < action.amount) {
        return {
          action_id: action.action_id,
          route: rule.after_window?.route ?? rule.route,
          option: rev.kind === "change" ? "change" : "cancel",
          cost: rev.cost_to_reverse,
          deadline: rev.window_ends_at,
        };
      }
      return keep(action);
    }

    case "none":
      return keep(action);
  }
}

function deadlineMs(step: PlanStep): number {
  return step.deadline === null ? Number.POSITIVE_INFINITY : timestampToMs(step.deadline);
}

function byUrgency(a: PlanStep, b: PlanStep): number {
  // "keep" steps are not fixes, so they go last.
  const aKeep = a.option === "keep" ? 1 : 0;
  const bKeep = b.option === "keep" ? 1 : 0;
  if (aKeep !== bKeep) {
    return aKeep - bKeep;
  }
  if (aKeep === 1) {
    // Nothing can still be fixed, so order by what the human loses, biggest first.
    return b.cost - a.cost || a.action_id.localeCompare(b.action_id);
  }
  const byDeadline = deadlineMs(a) - deadlineMs(b);
  if (byDeadline !== 0 && !Number.isNaN(byDeadline)) {
    return byDeadline;
  }
  return a.cost - b.cost || a.action_id.localeCompare(b.action_id);
}

export function planUndo(chain: Chain, actions: Action[], _preferences: Preferences, now: Timestamp): PlanStep[] {
  const byId = new Map<ActionId, Action>(actions.map((action) => [action.action_id, action]));
  const missing = chain.action_ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`plan_undo: the chain's actions were not passed in: ${missing.join(", ")}`);
  }

  return chain.action_ids
    .map((id) => byId.get(id) as Action)
    .filter((action) => !SETTLED_STATES.has(action.state))
    .map((action) => stepFor(action, now))
    .sort(byUrgency);
}
