// compare(intent, actions): exact field checks of what actually happened against what was asked for.
//
// MismatchField is fixed by types.ts: dates, amount, term, item, duplicate. How each is used:
//   dates      an action outside the intent's date range
//   amount     the running total goes over budget_total (reported once, on the action that crosses it)
//   term       annual instead of monthly, or a subscription the task never allowed
//   item       a wrong item (size, model...), a wrong quantity, or an action outside the allowed categories
//   duplicate  the same booking made twice
//
// must_haves convention (free text is ignored): "key:value" entries.
//   term:monthly | term:annual             saas actions
//   item:/size:/model:/color:/plan:        store and saas actions; the value must appear in the action summary
//   quantity:N | qty:N                     the quantity found in the summary ("x10", "10 units", "qty 10") must be N
//
// Every mismatch carries `evidence`: which action's receipt it was read from and the values read from it.

import type {
  Action,
  ActionId,
  ActionState,
  DateRange,
  Intent,
  IntentConstraints,
  Mismatch,
  MismatchEvidence,
  MismatchValue,
} from "../types.js";
import { dateToMs, timestampToMs } from "./dates.js";

/** Actions already refunded or deliberately kept are not compared again. */
const SETTLED_STATES: ReadonlySet<ActionState> = new Set(["verified", "kept"]);

const ITEM_KEYS: ReadonlySet<string> = new Set(["item", "size", "model", "color", "plan"]);
// Words and shapes receipts use for a billing term: "annual", "yearly", "per year", "12-month", "/yr", "/year",
// ISO durations P1Y and P12M, and the monthly equivalents.
const ANNUAL = /\b(annual|annually|yearly|per year|12[- ]month|P1Y|P12M)\b|\/\s*(?:yr|year)\b/i;
const MONTHLY = /\b(monthly|per month|month[- ]to[- ]month|P1M)\b|\/\s*(?:mo|month)\b/i;
const MUST_HAVE = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i;
const QUANTITY_IN_SUMMARY = /(?:\bx\s*|\bqty:?\s*|\bquantity:?\s*)(\d+)\b|\b(\d+)\s*(?:units?|pcs|pieces|items?)\b/i;

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

function wantedQuantity(constraints: IntentConstraints): number | null {
  for (const entry of constraints.must_haves ?? []) {
    const parsed = parseMustHave(entry);
    if (parsed && (parsed.key === "quantity" || parsed.key === "qty")) {
      const n = Number.parseInt(parsed.value, 10);
      if (Number.isInteger(n) && n > 0) {
        return n;
      }
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

function quantityIn(summary: string): number | null {
  const match = summary.match(QUANTITY_IN_SUMMARY);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? null : Number.parseInt(raw, 10);
}

/** The values read off an action's receipt, plus anything extra that explains the mismatch. */
function evidenceFor(action: Action, extra: Record<string, MismatchValue> = {}): MismatchEvidence {
  return {
    source_action_id: action.action_id,
    receipt_fields: {
      ref: action.ref,
      merchant: action.merchant,
      category: action.category,
      summary: action.summary,
      amount: action.amount,
      dates_start: action.dates?.start ?? null,
      dates_end: action.dates?.end ?? null,
      source: action.source,
      received_at: action.received_at,
      ...extra,
    },
  };
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

  let expected: string;
  let actual: string;
  if (start < rangeStart) {
    expected = range.start;
    actual = action.dates.start;
  } else if (start > rangeEnd) {
    expected = range.end ?? range.start;
    actual = action.dates.start;
  } else if (end > rangeEnd) {
    expected = range.end ?? range.start;
    actual = action.dates.end ?? action.dates.start;
  } else {
    return null;
  }
  return {
    action_id: action.action_id,
    field: "dates",
    expected,
    actual,
    evidence: evidenceFor(action, { intent_start: range.start, intent_end: range.end ?? null }),
  };
}

/**
 * The first action (in received order) that pushes the running total over budget. Total equal to budget is fine.
 * A charge seen by Stripe and also by email has the same ref: it is counted once, from the receipt, not twice.
 */
function budgetCrossing(budget: number | undefined, ordered: Action[]): { action_id: ActionId; total: number } | null {
  if (budget === undefined) {
    return null;
  }
  const receiptRefs = new Set(ordered.filter((a) => a.source !== "stripe").map((a) => a.ref));
  let total = 0;
  for (const action of ordered) {
    if (action.source === "stripe" && receiptRefs.has(action.ref)) {
      continue;
    }
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
      found.push({
        action_id: action.action_id,
        field: "item",
        expected: parsed.value,
        actual: action.summary,
        evidence: evidenceFor(action, { must_have: entry }),
      });
    }
  }
  return found;
}

function quantityMismatch(constraints: IntentConstraints, action: Action): Mismatch | null {
  const wanted = wantedQuantity(constraints);
  if (wanted === null || (action.category !== "store" && action.category !== "saas")) {
    return null;
  }
  const actual = quantityIn(action.summary);
  if (actual === null || actual === wanted) {
    return null;
  }
  return {
    action_id: action.action_id,
    field: "item",
    expected: `quantity ${wanted}`,
    actual: `quantity ${actual}`,
    evidence: evidenceFor(action, { quantity: actual, wanted_quantity: wanted }),
  };
}

/** The task named the kinds of things the agent may buy, and this action is not one of them. Messages are exempt. */
function offTaskMismatch(constraints: IntentConstraints, action: Action): Mismatch | null {
  const allowed = constraints.categories;
  if (!allowed || action.category === "message" || allowed.includes(action.category)) {
    return null;
  }
  const allowedList = allowed.join(", ");
  if (action.category === "saas") {
    // A subscription the task never allowed is reported on `term`.
    return {
      action_id: action.action_id,
      field: "term",
      expected: "no subscription",
      actual: actualTerm(action.summary) ?? "subscription",
      evidence: evidenceFor(action, { allowed_categories: allowedList }),
    };
  }
  return {
    action_id: action.action_id,
    field: "item",
    expected: `one of: ${allowedList}`,
    actual: action.category,
    evidence: evidenceFor(action, { allowed_categories: allowedList }),
  };
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
        evidence: evidenceFor(action, { running_total: crossing.total, budget_total: constraints.budget_total }),
      });
    }
    const offTask = offTaskMismatch(constraints, action);
    if (offTask) {
      mismatches.push(offTask);
    }
    if (wanted && action.category === "saas") {
      const actual = actualTerm(action.summary);
      // A subscription already reported as unexpected is not reported a second time.
      if (actual && actual !== wanted && offTask?.field !== "term") {
        mismatches.push({
          action_id: action.action_id,
          field: "term",
          expected: wanted,
          actual,
          evidence: evidenceFor(action, { wanted_term: wanted }),
        });
      }
    }
    mismatches.push(...itemMismatches(constraints, action));
    const quantity = quantityMismatch(constraints, action);
    if (quantity) {
      mismatches.push(quantity);
    }
    const original = duplicates.get(action.action_id);
    if (original) {
      mismatches.push({
        action_id: action.action_id,
        field: "duplicate",
        expected: null,
        actual: original.action_id,
        evidence: evidenceFor(action, { original_ref: original.ref, original_action_id: original.action_id }),
      });
    }
  }
  return mismatches;
}
