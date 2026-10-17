// compare(intent, actions): exact field checks of what actually happened against what was asked for.
//
// v1 fields (MismatchField): dates, amount, term, item, duplicate.
// must_haves convention (free text is ignored): "key:value" entries.
//   term:monthly | term:annual        -> saas actions
//   item:/size:/model:/color:/plan:   -> store and saas actions; the value must appear in the action summary

import type { Action, ActionId, ActionState, DateRange, Intent, IntentConstraints, Mismatch } from "../types.js";
import { dateToMs, timestampToMs } from "./dates.js";

/** Actions already refunded or deliberately kept are not compared again. */
const SETTLED_STATES: ReadonlySet<ActionState> = new Set(["verified", "kept"]);

const ITEM_KEYS: ReadonlySet<string> = new Set(["item", "size", "model", "color", "plan"]);
const ANNUAL = /\b(annual|annually|yearly|per year|12[- ]month)\b/i;
const MONTHLY = /\b(monthly|per month|month[- ]to[- ]month)\b/i;
const MUST_HAVE = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i;

type Term = "monthly" | "annual";

function byReceived(a: Action, b: Action): number {
  const diff = timestampToMs(a.received_at) - timestampToMs(b.received_at);
  return diff !== 0 ? diff : a.action_id.localeCompare(b.action_id);
}

function parseMustHave(entry: string): { key: string; value: string } | null {
  const match = entry.match(MUST_HAVE);
  return match ? { key: match[1].toLowerCase(), value: match[2] } : null;
}

function wantedTerm(constraints: IntentConstraints): Term | null {
  for (const entry of constraints.must_haves ?? []) {
    const parsed = parseMustHave(entry);
    if (parsed?.key !== "term") {
      continue;
    }
    const value = parsed.value.toLowerCase();
    if (value.startsWith("month")) {
      return "monthly";
    }
    if (value.startsWith("annual") || value.startsWith("year")) {
      return "annual";
    }
  }
  return null;
}

function actualTerm(summary: string): Term | null {
  if (ANNUAL.test(summary)) {
    return "annual";
  }
  if (MONTHLY.test(summary)) {
    return "monthly";
  }
  return null;
}

/** An action must fall inside the intent's date range. Start is checked first, then end. */
function dateMismatch(range: DateRange | undefined, action: Action): Mismatch | null {
  if (!range || !action.dates) {
    return null;
  }
  const rangeStart = dateToMs(range.start);
  const rangeEnd = dateToMs(range.end ?? range.start);
  const start = dateToMs(action.dates.start);
  const end = dateToMs(action.dates.end ?? action.dates.start);

  if (start < rangeStart) {
    return { action_id: action.action_id, field: "dates", expected: range.start, actual: action.dates.start };
  }
  if (start > rangeEnd) {
    return {
      action_id: action.action_id,
      field: "dates",
      expected: range.end ?? range.start,
      actual: action.dates.start,
    };
  }
  if (end > rangeEnd) {
    return {
      action_id: action.action_id,
      field: "dates",
      expected: range.end ?? range.start,
      actual: action.dates.end ?? action.dates.start,
    };
  }
  return null;
}

/** The first action (in received order) that pushes the running total over budget. Total equal to budget is fine. */
function budgetCrossing(budget: number | undefined, ordered: Action[]): { action_id: ActionId; total: number } | null {
  if (budget === undefined) {
    return null;
  }
  let total = 0;
  for (const action of ordered) {
    total += action.amount;
    if (total > budget) {
      return { action_id: action.action_id, total };
    }
  }
  return null;
}

function itemMismatches(constraints: IntentConstraints, action: Action): Mismatch[] {
  if (action.category !== "store" && action.category !== "saas") {
    return [];
  }
  const summary = action.summary.toLowerCase();
  const found: Mismatch[] = [];
  for (const entry of constraints.must_haves ?? []) {
    const parsed = parseMustHave(entry);
    if (parsed && ITEM_KEYS.has(parsed.key) && !summary.includes(parsed.value.toLowerCase())) {
      found.push({ action_id: action.action_id, field: "item", expected: parsed.value, actual: action.summary });
    }
  }
  return found;
}

/** Maps each duplicate to the earlier booking it repeats. Same merchant, category, amount and dates, different ref. */
function findDuplicates(ordered: Action[]): Map<ActionId, Action> {
  const firstSeen = new Map<string, Action>();
  const duplicates = new Map<ActionId, Action>();
  for (const action of ordered) {
    if (action.category === "message" || action.amount === 0) {
      continue;
    }
    const key = [action.merchant, action.category, action.amount, action.dates?.start ?? "", action.dates?.end ?? ""].join("|");
    const original = firstSeen.get(key);
    if (!original) {
      firstSeen.set(key, action);
    } else if (original.ref !== action.ref) {
      duplicates.set(action.action_id, original);
    }
  }
  return duplicates;
}

export function compare(intent: Intent, actions: Action[]): Mismatch[] {
  const live = actions.filter((action) => !SETTLED_STATES.has(action.state)).sort(byReceived);
  const { constraints } = intent;
  const crossing = budgetCrossing(constraints.budget_total, live);
  const duplicates = findDuplicates(live);
  const wanted = wantedTerm(constraints);

  const mismatches: Mismatch[] = [];
  for (const action of live) {
    const dates = dateMismatch(constraints.dates, action);
    if (dates) {
      mismatches.push(dates);
    }
    if (crossing && crossing.action_id === action.action_id && constraints.budget_total !== undefined) {
      mismatches.push({
        action_id: action.action_id,
        field: "amount",
        expected: constraints.budget_total,
        actual: crossing.total,
      });
    }
    if (wanted && action.category === "saas") {
      const actual = actualTerm(action.summary);
      if (actual && actual !== wanted) {
        mismatches.push({ action_id: action.action_id, field: "term", expected: wanted, actual });
      }
    }
    mismatches.push(...itemMismatches(constraints, action));
    const original = duplicates.get(action.action_id);
    if (original) {
      mismatches.push({ action_id: action.action_id, field: "duplicate", expected: null, actual: original.action_id });
    }
  }
  return mismatches;
}
