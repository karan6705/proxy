// Date helpers for the pure logic. No Date.now(): every function takes its time as an argument.

import type { CalendarDate, Timestamp } from "../types.js";

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** "2026-11-03" -> midnight UTC of that day, in ms. */
export function dateToMs(date: CalendarDate): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  return ms;
}

export function timestampToMs(timestamp: Timestamp): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return ms;
}

export function msToTimestamp(ms: number): Timestamp {
  return new Date(ms).toISOString();
}

/** Inclusive overlap of two calendar-date ranges. A missing end means a single day. */
export function rangesOverlap(
  a: { start: CalendarDate; end?: CalendarDate },
  b: { start: CalendarDate; end?: CalendarDate },
): boolean {
  const aStart = dateToMs(a.start);
  const aEnd = dateToMs(a.end ?? a.start);
  const bStart = dateToMs(b.start);
  const bEnd = dateToMs(b.end ?? b.start);
  return aStart <= bEnd && bStart <= aEnd;
}
