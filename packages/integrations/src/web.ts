import { LedgerService } from "@researchmate/billing";
import { approvedWebDomains, type Database } from "@researchmate/database";
import { AppError, assertSafeOutboundUrl } from "@researchmate/shared";
import type { FileService } from "@researchmate/storage";
import { getProjectAccess, requireOrgPermission } from "@researchmate/tenancy";
import { and, eq } from "drizzle-orm";

const MAX_BYTES = 3 * 1024 * 1024;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m)));

/** Readable text from HTML: scripts, styles and navigation chrome removed, block elements become line breaks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

export const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

export interface WebCaptureDeps {
  files: FileService;
  /** Adds the captured page to the library and attaches the snapshot (LiteratureService). */
  library: {
    addItems: (actor: string, projectId: string, items: Record<string, unknown>[], prov: { provider: string; status: "metadata_retrieved"; access: () => "metadata"; retrievedAt: string }) => Promise<{ added: { id: string; citationKey: string }[]; duplicates: { existingId: string }[] }>;
    attachFullText: (actor: string, referenceId: string, fileId: string) => Promise<void>;
  };
  /** Platform-wide approved domains (WEB_APPROVED_DOMAINS). */
  platformDomains?: string[];
  allowPrivateEndpoints?: boolean;
  fetch?: typeof fetch;
}

/**
 * Captures pages from approved public websites (§15) as research sources:
 * a dated text snapshot is stored as a project file (searchable, usable for
 * evidence) and the page is added to the library with its URL and access
 * date. Only domains an organization admin (or the platform) approved can
 * be fetched; every hop of a redirect is re-checked; sizes are capped.
 */
export class WebCaptureService {
  private readonly ledger: LedgerService;
  constructor(
    private readonly db: Database,
    private readonly deps: WebCaptureDeps,
  ) {
    this.ledger = new LedgerService(db);
  }

  async domains(organizationId: string) {
    const rows = await this.db.select().from(approvedWebDomains).where(eq(approvedWebDomains.organizationId, organizationId));
    return { organization: rows.map((r) => r.domain).sort(), platform: (this.deps.platformDomains ?? []).map(normalizeDomain).filter(Boolean) };
  }

  async addDomain(actorUserId: string, organizationId: string, domain: string) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.settings.manage");
    const d = normalizeDomain(domain);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) throw new AppError("VALIDATION", "Enter a domain such as who.int.");
    await this.db.insert(approvedWebDomains).values({ organizationId, domain: d, addedByUserId: actorUserId }).onConflictDoNothing();
  }

  async removeDomain(actorUserId: string, organizationId: string, domain: string) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.settings.manage");
    await this.db.delete(approvedWebDomains).where(and(eq(approvedWebDomains.organizationId, organizationId), eq(approvedWebDomains.domain, normalizeDomain(domain))));
  }

  private async approved(organizationId: string, host: string) {
    const h = host.toLowerCase().replace(/^www\./, "");
    const { organization, platform } = await this.domains(organizationId);
    return [...organization, ...platform].some((d) => h === d || h.endsWith(`.${d}`));
  }

  async capture(actorUserId: string, projectId: string, rawUrl: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to the project.");
    let url = new URL(String(rawUrl).trim());
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!["http:", "https:"].includes(url.protocol)) throw new AppError("VALIDATION", "Only web pages (http/https) can be captured.");
      if (!(await this.approved(access.organizationId, url.hostname))) throw new AppError("FORBIDDEN", `${url.hostname} isn't an approved website. An organization admin can approve it in Settings → Integrations.`);
      await assertSafeOutboundUrl(url.toString(), { allowPrivate: this.deps.allowPrivateEndpoints, requireHttps: false });
      res = await (this.deps.fetch ?? fetch)(url, { redirect: "manual", headers: { "user-agent": "ResearchMate/1.0 (research source capture)", accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9" }, signal: AbortSignal.timeout(20_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      break;
    }
    if (!res || res.status >= 300) throw new AppError("VALIDATION", `The page couldn't be fetched (${res?.status ?? "no response"}).`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!["text/html", "application/xhtml+xml", "text/plain", "application/pdf"].includes(type)) throw new AppError("VALIDATION", `Pages of type “${type || "unknown"}” can't be captured.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > MAX_BYTES) throw new AppError("VALIDATION", "The page is larger than 3 MB.");
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    const retrievedAt = new Date().toISOString();
    let title = url.hostname;
    let snapshot: Buffer;
    let filename: string;
    if (type === "application/pdf") {
      snapshot = buf;
      filename = `${url.hostname}${url.pathname.replace(/[^A-Za-z0-9._-]+/g, "_")}`.slice(0, 120).replace(/(\.pdf)?$/i, ".pdf");
    } else {
      const parsed = type === "text/plain" ? { title: "", text: buf.toString("utf8") } : htmlToText(buf.toString("utf8"));
      title = parsed.title || url.hostname;
      if (parsed.text.length < 50) throw new AppError("VALIDATION", "The page has too little readable text to capture.");
      snapshot = Buffer.from(`Source: ${url.toString()}\nTitle: ${title}\nRetrieved: ${retrievedAt}\n\n${parsed.text}\n`, "utf8");
      filename = `Web snapshot - ${title}`.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) + ".txt";
    }
    const file = await this.deps.files.upload({ actorUserId, organizationId: access.organizationId, projectId, filename, declaredSize: snapshot.length, body: [snapshot] as never });
    const accessed = retrievedAt.slice(0, 10).split("-").map(Number);
    const r = await this.deps.library.addItems(actorUserId, projectId, [{ id: "", type: "webpage", title, URL: url.toString(), "container-title": url.hostname, accessed: { "date-parts": [accessed] } }], { provider: "web", status: "metadata_retrieved", access: () => "metadata", retrievedAt });
    const refId = r.added[0]?.id ?? r.duplicates[0]?.existingId;
    if (refId) await this.deps.library.attachFullText(actorUserId, refId, file.id);
    await this.ledger.meterService(this.db, { organizationId: access.organizationId, projectId, userId: actorUserId, serviceKey: "crawl.pages", quantity: 1, unit: "page", sourceType: "web_capture", sourceId: file.id });
    return { referenceId: refId ?? null, fileId: file.id, title, url: url.toString(), duplicate: !r.added.length };
  }
}
