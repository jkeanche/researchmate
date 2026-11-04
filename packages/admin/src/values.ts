import { type EntitlementValue, FEATURES, type FeatureKey, isFeatureKey } from "@researchmate/database";
import { AppError } from "@researchmate/shared";

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/**
 * Turns what an administrator typed into a stored entitlement value, using the
 * feature catalogue to decide what is valid:
 *  - limits: a whole number, or "unlimited" (stored as null); sizes accept KB/MB/GB/TB;
 *    money limits are entered in US dollars;
 *  - flags: on/off;
 *  - tiers: one of the feature's tiers.
 */
export function parseEntitlementValue(key: string, raw: string): EntitlementValue {
  if (!isFeatureKey(key)) throw new AppError("VALIDATION", `Unknown feature “${key}”.`);
  const def = FEATURES[key];
  const v = raw.trim().toLowerCase();
  if (def.kind === "flag") {
    if (["on", "true", "yes", "1"].includes(v)) return true;
    if (["off", "false", "no", "0", ""].includes(v)) return false;
    throw new AppError("VALIDATION", `${key}: choose on or off.`);
  }
  if (def.kind === "tier") {
    if (!(def.tiers as readonly string[]).includes(v)) throw new AppError("VALIDATION", `${key}: choose one of ${def.tiers.join(", ")}.`);
    return v;
  }
  if (v === "unlimited" || v === "∞") return null;
  if (def.unit === "bytes") {
    const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(v.replace(/,/g, ""));
    if (!m) throw new AppError("VALIDATION", `${key}: enter a size such as 500 MB or 5 GB, or “unlimited”.`);
    const bytes = Math.round(Number(m[1]) * UNITS[m[2] ?? "b"]!);
    if (!Number.isSafeInteger(bytes)) throw new AppError("VALIDATION", `${key}: that size is too large.`);
    return bytes;
  }
  if (def.unit === "micro_usd") {
    const m = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(v.replace(/,/g, ""));
    if (!m) throw new AppError("VALIDATION", `${key}: enter an amount in US dollars, e.g. 5 or 12.50.`);
    return Math.round(Number(m[1]) * 1_000_000);
  }
  if (!/^\d+$/.test(v.replace(/,/g, ""))) throw new AppError("VALIDATION", `${key}: enter a whole number, or “unlimited”.`);
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isSafeInteger(n)) throw new AppError("VALIDATION", `${key}: that number is too large.`);
  return n;
}

/** The inverse of parseEntitlementValue, for showing a value in a form field. */
export function formatEntitlementValue(key: FeatureKey, value: EntitlementValue | undefined): string {
  const def = FEATURES[key];
  if (def.kind === "flag") return value === true ? "on" : "off";
  if (def.kind === "tier") return typeof value === "string" ? value : def.tiers[0]!;
  if (value === null) return "unlimited";
  if (typeof value !== "number") return "0";
  if (def.unit === "bytes") {
    // Exact units only, so saving the form unchanged never alters the value.
    if (value === 0) return "0";
    for (const u of ["tb", "gb", "mb", "kb"] as const) if (value % UNITS[u]! === 0) return `${value / UNITS[u]!} ${u.toUpperCase()}`;
    return String(value);
  }
  if (def.unit === "micro_usd") return (value / 1_000_000).toFixed(2);
  return String(value);
}

/** Parses an amount in major currency units ("1,500.50") into minor units (150050). */
export function parseMoneyMinor(raw: string, what = "Amount"): number {
  const v = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new AppError("VALIDATION", `${what}: enter an amount such as 1500 or 12.50.`);
  const minor = Math.round(Number(v) * 100);
  if (!Number.isSafeInteger(minor) || minor > 2_000_000_000) throw new AppError("VALIDATION", `${what} is too large.`);
  return minor;
}

export function parseCurrency(raw: string): string {
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new AppError("VALIDATION", "Currency must be a three-letter code such as USD or KES.");
  return c;
}

/** Escapes LIKE wildcards in user-entered search text. */
export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const PAGE_SIZE = 50;

export function pageOf(page: number | undefined) {
  const p = Number.isFinite(page) && page! > 0 ? Math.floor(page!) : 1;
  return { page: p, limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE };
}
