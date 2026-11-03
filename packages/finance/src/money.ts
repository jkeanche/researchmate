/**
 * Money helpers. Amounts are integer minor units; conversion uses BigInt
 * arithmetic on decimal strings, so no binary floating point touches money.
 */

const SUPPORTED = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []);

export function isCurrency(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) && (SUPPORTED.size === 0 || SUPPORTED.has(code));
}

export function fractionDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** "1,234.50" → 123450 (for a 2-decimal currency). Throws on malformed input or too many decimals. */
export function parseAmount(input: string | number, currency: string, opts: { allowNegative?: boolean } = {}): number {
  const s = String(input).trim().replace(/,/g, "");
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[1] && !opts.allowNegative)) throw new Error("Enter an amount like 1250 or 1250.50.");
  const fd = fractionDigits(currency);
  const frac = m[3] ?? "";
  if (frac.length > fd) throw new Error(`${currency} amounts have at most ${fd} decimal place${fd === 1 ? "" : "s"}.`);
  const minor = BigInt(m[2]!) * 10n ** BigInt(fd) + BigInt((frac + "0".repeat(fd)).slice(0, fd) || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("That amount is too large.");
  return Number(m[1] ? -minor : minor);
}

export function formatMoney(minor: number, currency: string): string {
  const fd = fractionDigits(currency);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: fd, maximumFractionDigits: fd }).format(minor / 10 ** fd);
}

/** Amount as a plain decimal string (for CSV/XLSX), e.g. 123450 KES → "1234.50". */
export function toDecimalString(minor: number, currency: string): string {
  const fd = fractionDigits(currency);
  const neg = minor < 0;
  const s = String(Math.abs(minor)).padStart(fd + 1, "0");
  const out = fd ? `${s.slice(0, -fd)}.${s.slice(-fd)}` : s;
  return neg ? `-${out}` : out;
}

const RATE_SCALE = 10n ** 10n;

export function isRate(v: unknown): v is string {
  return typeof v === "string" && /^\d+(\.\d{1,10})?$/.test(v.trim()) && Number(v) > 0;
}

function rateToScaled(rate: string): bigint {
  const [i, f = ""] = rate.trim().split(".");
  return BigInt(i!) * RATE_SCALE + BigInt((f + "0".repeat(10)).slice(0, 10));
}

/** Converts minor units of `from` to minor units of `to` at `rate` (units of `to` per 1 `from`), rounding half away from zero. */
export function convertMinor(amountMinor: number, from: string, to: string, rate: string): number {
  if (from === to) return amountMinor;
  const num = BigInt(amountMinor) * rateToScaled(rate) * 10n ** BigInt(fractionDigits(to));
  const den = 10n ** BigInt(fractionDigits(from)) * RATE_SCALE;
  const q = num / den;
  const r = num % den;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const rounded = abs(r) * 2n >= den ? q + (num < 0n ? -1n : 1n) : q;
  return Number(rounded);
}

/** 1 / rate with 10 decimal places (for using a stored rate in the other direction). */
export function invertRate(rate: string): string {
  const scaled = rateToScaled(rate);
  const inv = (RATE_SCALE * RATE_SCALE + scaled / 2n) / scaled;
  const s = inv.toString().padStart(11, "0");
  return `${s.slice(0, -10)}.${s.slice(-10)}`.replace(/\.?0+$/, "") || "0";
}
