/**
 * Calendar-date helpers. Planning works in whole calendar days (UTC), stored
 * as ISO `YYYY-MM-DD` strings, so time zones and daylight saving never shift
 * a task.
 */

const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Days since 1970-01-01. */
export function toDay(iso: string): number {
  if (!isIsoDate(iso)) throw new Error(`Invalid date: ${iso}`);
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

export function fromDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDay(toDay(iso) + days);
}

/** Inclusive number of days from a to b (same day = 1). */
export function spanDays(a: string, b: string): number {
  return toDay(b) - toDay(a) + 1;
}

export function diffDays(a: string, b: string): number {
  return toDay(b) - toDay(a);
}

/** Today's calendar date in an IANA time zone (falls back to UTC for unknown zones). */
export function todayIso(now = new Date(), timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}
