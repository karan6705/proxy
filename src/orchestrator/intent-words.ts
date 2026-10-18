// The human's own words vs the intent the agent logged. A deterministic parser only (no model): it reads dates
// ("Nov 13", "November 13-16", "13th of November", "the 13th", "2026-11-13", "11/13", "13/11/2026") and a budget
// ("under $1,500", "$1.5k") from original_request and compares them with the agent's constraints. Anything it can't
// read is left alone. A numeric date valid both ways ("3/11": Mar 11 or Nov 3) is ambiguous, and the human is asked.
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
/** 3/11, 11/13/2026, 13/11/26: day and month in either order, then an optional year. */
const NUMERIC = "(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?";
const ORDINAL = `(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTH})`;

export interface SaidIntent {
  dates?: DateRange;
  budget_total?: Cents;
  /** A numeric date that reads two ways: what was written and the other reading. `dates` is the month-first one. */
  ambiguous?: { written: string; other: DateRange };
}

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
/** A real calendar date (no Feb 30), as YYYY-MM-DD, or null. */
const real = (year: number, month: number, day: number) => {
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 ? iso(year, month, day) : null;
};
const fullYear = (y: string | undefined, fallback: number) => (y === undefined ? fallback : y.length === 2 ? 2000 + +y : +y);

/** The two readings of a numeric date or range: month first, then day first. Either is null when not a real date. */
function numericReadings(m: RegExpExecArray, year: number): [DateRange | null, DateRange | null] {
  const parts = [[m[1], m[2], m[3]], ...(m[4] ? [[m[4], m[5], m[6]]] : [])] as [string, string, string | undefined][];
  const read = (monthFirst: boolean): DateRange | null => {
    const days = parts.map(([a, b, y]) => (monthFirst ? real(fullYear(y, year), +a, +b) : real(fullYear(y, year), +b, +a)));
    if (days.some((d) => d === null)) return null;
    return { start: days[0]!, ...(days[1] ? { end: days[1] } : {}) };
  };
  return [read(true), read(false)];
}

/**
 * Dates and a budget from the human's words. `year` fills in a date written without one. `ref` (YYYY-MM-DD) gives
 * the month for a bare day like "the 13th": its month, or the next one if that day has already passed.
 */
export function parseRequest(text: string, year: number, ref?: string): SaidIntent {
  const said: SaidIntent = {};
  const t = text.toLowerCase();

  // Every date form that matches; the one written first wins.
  const found: { index: number; read: () => void }[] = [];
  const isoRange = new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})(?:${RANGE}(\\d{4})-(\\d{2})-(\\d{2}))?`).exec(t);
  if (isoRange) {
    found.push({
      index: isoRange.index,
      read: () => {
        const start = real(+isoRange[1]!, +isoRange[2]!, +isoRange[3]!);
        const end = isoRange[4] ? real(+isoRange[4], +isoRange[5]!, +isoRange[6]!) : null;
        if (start) said.dates = { start, ...(end ? { end } : {}) };
      },
    });
  }
  const monthFirst = new RegExp(`\\b${MONTH}\\s+${DAY}\\b(?:${RANGE}(?:${MONTH}\\s+)?${DAY}\\b)?`).exec(t);
  if (monthFirst) {
    found.push({
      index: monthFirst.index,
      read: () => {
        const m1 = MONTHS[monthFirst[1]!.replace(".", "")]!;
        const start = real(year, m1, +monthFirst[2]!);
        if (!start) return;
        const m2 = monthFirst[3] ? MONTHS[monthFirst[3].replace(".", "")]! : m1;
        const end = monthFirst[4] ? real(year, m2, +monthFirst[4]) : null;
        said.dates = { start, ...(end ? { end } : {}) };
      },
    });
  }
  const dayFirst = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b(?:${RANGE}${DAY}\\s+(?:of\\s+)?${MONTH}\\b)?`).exec(t);
  if (dayFirst) {
    found.push({
      index: dayFirst.index,
      read: () => {
        const start = real(year, MONTHS[dayFirst[2]!.replace(".", "")]!, +dayFirst[1]!);
        if (!start) return;
        const end = dayFirst[3] && dayFirst[4] ? real(year, MONTHS[dayFirst[4].replace(".", "")]!, +dayFirst[3]) : null;
        said.dates = { start, ...(end ? { end } : {}) };
      },
    });
  }
  const numeric = new RegExp(`(?<![\\d/$.,])${NUMERIC}(?:${RANGE}${NUMERIC})?(?![\\d/])`).exec(t);
  if (numeric) {
    found.push({
      index: numeric.index,
      read: () => {
        const [md, dm] = numericReadings(numeric, year);
        const first = md ?? dm;
        if (!first) return;
        said.dates = first;
        if (md && dm && (md.start !== dm.start || md.end !== dm.end)) said.ambiguous = { written: numeric[0], other: dm };
      },
    });
  }
  const ordinal = ref ? new RegExp(`\\bthe\\s+${ORDINAL}(?:${RANGE}${ORDINAL})?`).exec(t) : null;
  if (ordinal && ref) {
    found.push({
      index: ordinal.index,
      read: () => {
        // "the 13th": the reference month, or the next month if that day is already past.
        let y = +ref.slice(0, 4);
        let m = +ref.slice(5, 7);
        const d1 = +ordinal[1]!;
        if (d1 < +ref.slice(8, 10)) [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
        const start = real(y, m, d1);
        if (!start) return;
        const d2 = ordinal[3] ? +ordinal[3] : null;
        const end = d2 === null ? null : d2 >= d1 ? real(y, m, d2) : m === 12 ? real(y + 1, 1, d2) : real(y, m + 1, d2);
        said.dates = { start, ...(end ? { end } : {}) };
      },
    });
  }
  found.sort((a, b) => a.index - b.index)[0]?.read();

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

export interface IntentChoice {
  /** The reading as the human wrote it, e.g. "Mar 11". */
  label: string;
  /** The constraints this reading means, with the trip's length kept; absent when it is what the agent logged. */
  corrected?: Pick<IntentConstraints, "dates" | "budget_total">;
}

export interface IntentCheck {
  /** absent: no words, or nothing in them Proxy can read (`checkable: false`), so nothing is checked or sent. */
  status: "agrees" | "disagrees" | "absent";
  /** False when the human's words were given but contain no date or budget Proxy can read. */
  checkable?: boolean;
  /** What the agent logged, for the fields that disagree ("Nov 3 to Nov 6"). */
  understood?: string;
  /** What the human said, for the same fields ("Nov 13 to Nov 16", or "3/11 (Mar 11 or Nov 3)"). */
  said?: string;
  /** The constraints to use if the human picks their own words (for an ambiguous date, the reading the agent didn't take). */
  corrected?: Pick<IntentConstraints, "dates" | "budget_total">;
  /** An ambiguous numeric date the agent read one way: what was written, the agent's reading, and reply 1 and 2. */
  ambiguous?: { written: string; agent_reading: string; choices: [IntentChoice, IntentChoice] };
}

const range = (d: DateRange | undefined) => (d ? `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "no dates");
const budget = (c: Cents | undefined) => (c === undefined ? "no budget" : `under ${money(c)}`);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** The human's dates, keeping the trip's length when they gave only a start date. */
function withLength(said: DateRange, agent: DateRange | undefined): DateRange {
  if (said.end || !agent?.end) return said;
  return { start: said.start, end: new Date(dayMs(said.start) + dayMs(agent.end) - dayMs(agent.start)).toISOString().slice(0, 10) };
}

/**
 * Compares the human's words with the agent's constraints. Only fields the human actually mentioned count.
 * `today` (YYYY-MM-DD) places a bare day like "the 13th" when the agent logged no dates.
 */
export function checkIntent(constraints: IntentConstraints, original_request: string | undefined, year: number, today?: string): IntentCheck {
  if (!original_request?.trim()) return { status: "absent" };
  const agent = constraints.dates;
  const said = parseRequest(original_request, agent ? Number(agent.start.slice(0, 4)) : year, agent ? `${agent.start.slice(0, 8)}01` : today?.slice(0, 10));
  if (!said.dates && said.budget_total === undefined) return { status: "absent", checkable: false };

  const understood: string[] = [];
  const saidParts: string[] = [];
  const corrected: NonNullable<IntentCheck["corrected"]> = {};
  const budgetDiffers = said.budget_total !== undefined && said.budget_total !== constraints.budget_total;

  if (said.dates) {
    const readings = said.ambiguous ? [said.dates, said.ambiguous.other] : [said.dates];
    const matches = (r: DateRange) => agent?.start === r.start && (!r.end || agent.end === r.end);
    const hit = readings.findIndex(matches);
    if (said.ambiguous && hit !== -1 && !budgetDiffers) {
      // "3/11" and the agent took one reading: ask which one the human meant.
      const choices = readings.map((r, i) => ({ label: range(r), ...(i === hit ? {} : { corrected: { dates: withLength(r, agent) } }) })) as [IntentChoice, IntentChoice];
      return {
        status: "disagrees",
        understood: range(agent),
        said: `${said.ambiguous.written} (${choices[0].label} or ${choices[1].label})`,
        corrected: choices[1 - hit]!.corrected!,
        ambiguous: { written: said.ambiguous.written, agent_reading: range(readings[hit]), choices },
      };
    }
    if (hit === -1) {
      // A plain disagreement. For an ambiguous date that matches neither reading, the month-first one is put forward.
      const dates = withLength(said.dates, agent);
      understood.push(range(agent));
      saidParts.push(range(dates));
      corrected.dates = dates;
    } else if (readings.length === 2) {
      // The agent took one reading of an ambiguous date and the budget differs too: the other reading is the human's.
      const dates = withLength(readings[1 - hit]!, agent);
      understood.push(range(agent));
      saidParts.push(range(dates));
      corrected.dates = dates;
    }
  }
  if (budgetDiffers) {
    understood.push(budget(constraints.budget_total));
    saidParts.push(budget(said.budget_total));
    corrected.budget_total = said.budget_total;
  }
  if (!understood.length) return { status: "agrees" };
  return { status: "disagrees", understood: understood.join(", "), said: saidParts.join(", "), corrected };
}

/**
 * "Your agent understood <X>. You said <Y>. Reply 1 for <Y> or 2 for <X>.", or for an ambiguous date
 * "You wrote 3/11. Your agent read it as Nov 3. Did you mean Mar 11 or Nov 3? Reply 1 or 2."
 */
export function intentQuestion(check: IntentCheck): string {
  const a = check.ambiguous;
  if (a) return `You wrote ${a.written}. Your agent read it as ${a.agent_reading}. Did you mean ${a.choices[0].label} or ${a.choices[1].label}? Reply 1 or 2.`;
  return `Your agent understood ${check.understood}. You said ${check.said}. Reply 1 for ${check.said} or 2 for ${check.understood}.`;
}

/** What reply 1 or 2 means: the constraints to apply (none keeps the agent's version) and the confirmation text. */
export function intentAnswer(check: IntentCheck, choice: 1 | 2): { corrected?: IntentCheck["corrected"]; said: string } {
  if (check.ambiguous) {
    const picked = check.ambiguous.choices[choice - 1]!;
    return picked.corrected ? { corrected: picked.corrected, said: range(picked.corrected.dates) } : { said: picked.label };
  }
  return choice === 1 ? { ...(check.corrected ? { corrected: check.corrected } : {}), said: check.said ?? "" } : { said: check.understood ?? "" };
}
