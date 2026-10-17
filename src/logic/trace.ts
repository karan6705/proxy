// trace(intent, actions, mismatches): groups a root mistake with everything that depends on it into one chain.
//
// v1 linking rule: two flagged actions are in the same chain when both have a wrong-dates mismatch and their date
// ranges overlap (a wrong arrival date drags in the hotel nights, the transfer and the arrival message).
// Every other mismatch (amount, term, item, duplicate) is its own chain. The chain id is derived from the root
// action, so tracing again after a late confirmation arrives keeps the same chain id.

import type { Action, ActionId, Chain, Intent, Mismatch } from "../types.js";
import { rangesOverlap, timestampToMs } from "./dates.js";
import { windowEndsAt } from "./reversibility.js";

function byReceived(a: Action, b: Action): number {
  const diff = timestampToMs(a.received_at) - timestampToMs(b.received_at);
  return diff !== 0 ? diff : a.action_id.localeCompare(b.action_id);
}

export function trace(intent: Intent, actions: Action[], mismatches: Mismatch[]): Chain[] {
  const byId = new Map(actions.map((action) => [action.action_id, action]));

  const flagged = new Set<ActionId>();
  const wrongDates = new Set<ActionId>();
  for (const mismatch of mismatches) {
    if (!byId.has(mismatch.action_id)) {
      continue;
    }
    flagged.add(mismatch.action_id);
    if (mismatch.field === "dates") {
      wrongDates.add(mismatch.action_id);
    }
  }

  const parent = new Map<ActionId, ActionId>([...flagged].map((id) => [id, id]));
  const find = (id: ActionId): ActionId => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root) as ActionId;
    }
    return root;
  };
  const union = (a: ActionId, b: ActionId): void => {
    parent.set(find(a), find(b));
  };

  const dated = [...wrongDates].map((id) => byId.get(id) as Action).filter((action) => action.dates);
  for (let i = 0; i < dated.length; i += 1) {
    for (let j = i + 1; j < dated.length; j += 1) {
      if (rangesOverlap(dated[i].dates!, dated[j].dates!)) {
        union(dated[i].action_id, dated[j].action_id);
      }
    }
  }

  const groups = new Map<ActionId, Action[]>();
  for (const id of flagged) {
    const root = find(id);
    const members = groups.get(root) ?? [];
    members.push(byId.get(id) as Action);
    groups.set(root, members);
  }

  const chains = [...groups.values()].map((members): Chain => {
    members.sort(byReceived);
    const root = members[0];
    const windows = members
      .map((member) => windowEndsAt(member))
      .filter((end): end is string => end !== null)
      .map((end) => timestampToMs(end));
    return {
      chain_id: `chain_${root.action_id}`,
      task_id: intent.task_id,
      root_action_id: root.action_id,
      action_ids: members.map((member) => member.action_id),
      money_at_risk: members.reduce((sum, member) => sum + member.amount, 0),
      window_ends_at: windows.length > 0 ? new Date(Math.min(...windows)).toISOString() : null,
      state: "detected",
      alerts: [],
      plan: [],
      steps: [],
    };
  });

  return chains.sort((a, b) => {
    const rootA = byId.get(a.root_action_id) as Action;
    const rootB = byId.get(b.root_action_id) as Action;
    return byReceived(rootA, rootB);
  });
}
