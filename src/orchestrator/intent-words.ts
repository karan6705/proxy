// The human's own words vs the intent the agent logged. A deterministic parser only (no model): it reads dates
// ("Nov 13", "November 13-16", "13th of November", "2026-11-13") and a budget ("under $1,500", "$1.5k") from
// original_request and compares them with the agent's constraints. Anything it can't read is left alone.
import type { Cents, DateRange, IntentConstraints } from "../types.js";
import { humanDate, money } from "./copy.js";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const RANGE = "\\s*(?:-|–|—|to|through|thru|until|till)\\s*(?:the\\s+)?";

export interface SaidIntent {
  dates?: DateRange;
  budget_total?: Cents;
}

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** Dates and a budget from the human's words. `year` fills in a date written without one. */
export function parseRequest(text: string, year: number): SaidIntent {
  const said: SaidIntent = {};
  const t = text.toLowerCase();

  const isoRange = new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})(?:${RANGE}(\\d{4})-(\\d{2})-(\\d{2}))?`).exec(t);
  const monthFirst = new RegExp(`\\b${MONTH}\\s+${DAY}\\b(?:${RANGE}(?:${MONTH}\\s+)?${DAY}\\b)?`).exec(t);
  const dayFirst = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b(?:${RANGE}${DAY}\\s+(?:of\\s+)?${MONTH}\\b)?`).exec(t);
  if (isoRange) {
    said.dates = { start: iso(+isoRange[1]!, +isoRange[2]!, +isoRange[3]!), ...(isoRange[4] ? { end: iso(+isoRange[4], +isoRange[5]!, +isoRange[6]!) } : {}) };
  } else if (monthFirst && (!dayFirst || monthFirst.index <= dayFirst.index)) {
    const m1 = MONTHS[monthFirst[1]!.replace(".", "")]!;
    const d1 = +monthFirst[2]!;
    if (valid(m1, d1)) {
      said.dates = { start: iso(year, m1, d1) };
      if (monthFirst[4]) {
        const m2 = monthFirst[3] ? MONTHS[monthFirst[3].replace(".", "")]! : m1;
        const d2 = +monthFirst[4];
        if (valid(m2, d2)) said.dates.end = iso(year, m2, d2);
      }
    }
  } else if (dayFirst) {
    const m1 = MONTHS[dayFirst[2]!.replace(".", "")]!;
    const d1 = +dayFirst[1]!;
    if (valid(m1, d1)) {
      said.dates = { start: iso(year, m1, d1) };
      if (dayFirst[3] && dayFirst[4]) {
        const m2 = MONTHS[dayFirst[4].replace(".", "")]!;
        if (valid(m2, +dayFirst[3])) said.dates.end = iso(year, m2, +dayFirst[3]);
      }
    }
  }

  // A budget: an amount after "under", "below", "max", "budget", "up to"…, or the only dollar amount.
  const amounts = [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/g)].map((m) => ({
    index: m.index ?? 0,
    cents: Math.round(parseFloat(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1) * 100),
  }));
  const budgetWord = /(under|below|less than|at most|max(?:imum)?|budget(?: of| is)?|up to|no more than|within)\s*$/;
  const flagged = amounts.find((a) => budgetWord.test(t.slice(Math.max(0, a.index - 20), a.index)));
  const budget = flagged ?? (amounts.length === 1 ? amounts[0] : undefined);
  if (budget && budget.cents > 0) said.budget_total = budget.cents;
  return said;
}

export interface IntentCheck {
  status: "agrees" | "disagrees" | "absent";
  /** What the agent logged, for the fields that disagree ("Nov 3 to Nov 6"). */
  understood?: string;
  /** What the human said, for the same fields ("Nov 13 to Nov 16"). */
  said?: string;
  /** The constraints to use if the human picks their own words. */
  corrected?: Pick<IntentConstraints, "dates" | "budget_total">;
}

const range = (d: DateRange | undefined) => (d ? `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "no dates");
const budget = (c: Cents | undefined) => (c === undefined ? "no budget" : `under ${money(c)}`);

/** Compares the human's words with the agent's constraints. Only fields the human actually mentioned count. */
export function checkIntent(constraints: IntentConstraints, original_request: string | undefined, year: number): IntentCheck {
  if (!original_request?.trim()) return { status: "absent" };
  const said = parseRequest(original_request, constraints.dates ? Number(constraints.dates.start.slice(0, 4)) : year);
  const understood: string[] = [];
  const saidParts: string[] = [];
  const corrected: IntentCheck["corrected"] = {};
  if (said.dates) {
    const agent = constraints.dates;
    const startDiffers = agent?.start !== said.dates.start;
    const endDiffers = Boolean(said.dates.end) && agent?.end !== said.dates.end;
    if (!agent || startDiffers || endDiffers) {
      // Keep the trip's length when the human gave only a start date.
      let end = said.dates.end;
      if (!end && agent?.end) end = new Date(Date.parse(`${said.dates.start}T00:00:00Z`) + (Date.parse(`${agent.end}T00:00:00Z`) - Date.parse(`${agent.start}T00:00:00Z`))).toISOString().slice(0, 10);
      const dates: DateRange = { start: said.dates.start, ...(end ? { end } : {}) };
      understood.push(range(agent));
      saidParts.push(range(dates));
      corrected.dates = dates;
    }
  }
  if (said.budget_total !== undefined && said.budget_total !== constraints.budget_total) {
    understood.push(budget(constraints.budget_total));
    saidParts.push(budget(said.budget_total));
    corrected.budget_total = said.budget_total;
  }
  if (!understood.length) return { status: "agrees" };
  return { status: "disagrees", understood: understood.join(", "), said: saidParts.join(", "), corrected };
}

/** "Your agent understood <X>. You said <Y>. Reply 1 for <Y> or 2 for <X>." */
export function intentQuestion(check: IntentCheck): string {
  return `Your agent understood ${check.understood}. You said ${check.said}. Reply 1 for ${check.said} or 2 for ${check.understood}.`;
}
