import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors";

/**
 * SSRF guard for URLs that users or admins configure (self-hosted AI
 * endpoints, MCP servers, webhooks). Rejects non-HTTP(S) schemes, embedded
 * credentials and, unless allowPrivate is set, any host that resolves to a
 * loopback, private, link-local, CGNAT or cloud-metadata address.
 *
 * Note: this checks resolution at validation time. Callers that connect later
 * should re-validate immediately before connecting (DNS can change).
 */
export async function assertSafeOutboundUrl(raw: string, opts: { allowPrivate?: boolean; requireHttps?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION", "Enter a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("VALIDATION", "Only http and https URLs are allowed.");
  if (opts.requireHttps && url.protocol !== "https:" && !opts.allowPrivate) throw new AppError("VALIDATION", "The URL must use https.");
  if (url.username || url.password) throw new AppError("VALIDATION", "Don't put credentials in the URL.");
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new AppError("VALIDATION", "That host could not be resolved.");
  for (const a of addresses) if (isPrivateAddress(a)) throw new AppError("VALIDATION", "That URL points to a private or internal address, which is not allowed.");
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}
