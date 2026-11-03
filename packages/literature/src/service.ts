import { LedgerService } from "@researchmate/billing";
import { type CslItem, normalizeDoi, parseBibtex, parseRis, toBibtex, toRis } from "@researchmate/citations";
import {
  type Database,
  evidenceRecords,
  filePassages,
  fileProcessingJobs,
  files,
  fileVersions,
  literatureMatrixEntries,
  references,
  researchQuestions,
  researchThemes,
  sourceVerificationEvents,
} from "@researchmate/database";
import { getEntitlements, tierOf } from "@researchmate/entitlements";
import { assertProjectWritable } from "@researchmate/research";
import { AppError, logger } from "@researchmate/shared";
import type { StorageDriver } from "@researchmate/storage";
import { getProjectAccess, recordAudit } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { EXTRACTABLE, extractText } from "./extract";
import { PROVIDERS, type ProviderKey, recordToCsl, ScholarlyClient, type ScholarlyRecord } from "./scholarly";

type Ref = typeof references.$inferSelect;
const ORDER = ["unverified", "metadata_retrieved", "metadata_verified", "full_text_retrieved", "full_text_reviewed"];
const ACCESS_RANK = { metadata: 0, abstract: 1, full_text: 2 } as const;

const normTitle = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const yearOf = (c: CslItem) => ("date-parts" in (c.issued ?? {}) ? ((c.issued as { "date-parts": number[][] })["date-parts"][0]?.[0] ?? null) : null);
const authorOf = (c: CslItem) => c.author?.[0]?.family ?? c.author?.[0]?.literal ?? null;

/** Builds a citation key like "suri2014" (with a/b/c suffixes when taken). */
export function makeCitationKey(c: CslItem, taken: Set<string>): string {
  const base = `${(authorOf(c) ?? normTitle(c.title ?? "ref").split(" ")[0] ?? "ref").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 30) || "ref"}${yearOf(c) ?? "nd"}`;
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26 * 26; i++) {
    const s = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(97 + Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26));
    if (!taken.has(base + s)) return base + s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const evidenceSchema = z.object({
  passage: z.string().trim().min(3, "Quote or summarise the passage").max(5000),
  claim: z.string().trim().max(2000).default(""),
  referenceId: z.string().uuid().nullable().optional().or(z.literal("").transform(() => null)),
  fileId: z.string().uuid().nullable().optional().or(z.literal("").transform(() => null)),
  page: z.coerce.number().int().positive().nullable().optional().or(z.literal("").transform(() => null)),
  researchQuestionId: z.string().uuid().nullable().optional().or(z.literal("").transform(() => null)),
  themeId: z.string().uuid().nullable().optional().or(z.literal("").transform(() => null)),
  notes: z.string().trim().max(2000).default(""),
});

const matrixSchema = z.object({
  objective: z.string().max(3000).default(""),
  methodology: z.string().max(3000).default(""),
  population: z.string().max(3000).default(""),
  findings: z.string().max(5000).default(""),
  limitations: z.string().max(3000).default(""),
  researchGap: z.string().max(3000).default(""),
  basis: z.enum(["metadata", "abstract", "full_text"]).default("abstract"),
});

function parse<T extends z.ZodTypeAny>(s: T, v: unknown): z.output<T> {
  const r = s.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]!.message);
  return r.data;
}

export interface LiteratureDeps {
  scholarly: ScholarlyClient;
  driver?: StorageDriver;
  enqueueExtraction?: (jobId: string) => Promise<void>;
  ocr?: boolean;
}

export class LiteratureService {
  constructor(
    private readonly db: Database,
    private readonly deps: LiteratureDeps,
  ) {}

  private async guard(actorUserId: string, projectId: string, write: boolean) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (write) {
      if (!access.permissions.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to this project.");
      await assertProjectWritable(this.db, projectId);
      const ent = await getEntitlements(this.db, access.organizationId);
      if (tierOf(ent, "toolkit") === "none") throw new AppError("FEATURE_NOT_ENTITLED", `The reference manager and literature tools are not included in the ${ent.planName} plan.`, { feature: "toolkit" });
    }
    return access;
  }

  // ----- References --------------------------------------------------------

  async list(actorUserId: string, projectId: string, q?: string) {
    await this.guard(actorUserId, projectId, false);
    const where = q?.trim() ? and(eq(references.projectId, projectId), sql`${references.search} @@ websearch_to_tsquery('english', ${q.trim()})`) : eq(references.projectId, projectId);
    return this.db.select().from(references).where(where).orderBy(asc(references.firstAuthor), asc(references.year));
  }

  async get(actorUserId: string, referenceId: string) {
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    await this.guard(actorUserId, r.projectId, false);
    const events = await this.db.select().from(sourceVerificationEvents).where(eq(sourceVerificationEvents.referenceId, referenceId)).orderBy(desc(sourceVerificationEvents.createdAt));
    return { reference: r, events };
  }

  private async event(referenceId: string, from: string, to: string, method: string, actorUserId: string | null, detail: Record<string, unknown> = {}) {
    await this.db.insert(sourceVerificationEvents).values({ referenceId, fromStatus: from, toStatus: to, method, actorUserId, detail });
  }

  /** Adds CSL items, skipping duplicates (same DOI, or same normalised title and year). */
  async addItems(actorUserId: string, projectId: string, items: CslItem[], provenance: { provider: string; status: "unverified" | "metadata_retrieved"; access?: (c: CslItem) => "metadata" | "abstract"; externalIds?: (c: CslItem) => Record<string, string>; retrievedAt?: string }) {
    await this.guard(actorUserId, projectId, true);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from research_projects where id = ${projectId} for update`);
      const existing = await tx.select({ id: references.id, key: references.citationKey, doi: references.doi, title: references.title, year: references.year }).from(references).where(eq(references.projectId, projectId));
      const keys = new Set(existing.map((e) => e.key));
      const dois = new Map(existing.filter((e) => e.doi).map((e) => [e.doi!, e.id]));
      const titles = new Map(existing.map((e) => [`${normTitle(e.title)}|${e.year ?? ""}`, e.id]));
      const added: Ref[] = [];
      const duplicates: { title: string; existingId: string }[] = [];
      for (const item of items) {
        if (!item.title?.trim()) continue;
        const doi = normalizeDoi(item.DOI ?? null);
        const tkey = `${normTitle(item.title)}|${yearOf(item) ?? ""}`;
        const dup = (doi && dois.get(doi)) || titles.get(tkey);
        if (dup) {
          duplicates.push({ title: item.title, existingId: dup });
          continue;
        }
        const key = item.id && /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,80}$/.test(item.id) && !keys.has(item.id) && !/^ris\d+$/.test(item.id) ? item.id : makeCitationKey(item, keys);
        keys.add(key);
        const { id: _drop, ...csl } = item;
        const [row] = await tx
          .insert(references)
          .values({
            projectId,
            citationKey: key,
            csl: { ...csl, ...(doi ? { DOI: doi } : {}) },
            title: item.title.trim().slice(0, 1000),
            year: yearOf(item),
            firstAuthor: authorOf(item),
            doi,
            verificationStatus: provenance.status,
            accessLevel: provenance.access?.(item) ?? (item.abstract ? "abstract" : "metadata"),
            sourceProvider: provenance.provider,
            externalIds: provenance.externalIds?.(item) ?? {},
            retrievedAt: provenance.retrievedAt ? new Date(provenance.retrievedAt) : null,
            createdByUserId: actorUserId,
          })
          .returning();
        added.push(row!);
        if (doi) dois.set(doi, row!.id);
        titles.set(tkey, row!.id);
        await tx.insert(sourceVerificationEvents).values({ referenceId: row!.id, fromStatus: "unverified", toStatus: provenance.status, method: provenance.provider, actorUserId, detail: {} });
      }
      return { added, duplicates };
    });
  }

  async addFromSearch(actorUserId: string, projectId: string, record: ScholarlyRecord) {
    const r = await this.addItems(actorUserId, projectId, [recordToCsl(record, "")], { provider: record.provider, status: "metadata_retrieved", access: () => record.access, externalIds: () => ({ [record.provider]: record.externalId }), retrievedAt: record.retrievedAt });
    return r.added[0] ?? null;
  }

  async addManual(actorUserId: string, projectId: string, input: { type?: string; title: string; authors?: string; year?: string | number; containerTitle?: string; volume?: string; issue?: string; pages?: string; publisher?: string; doi?: string; url?: string }) {
    const title = String(input.title ?? "").trim();
    if (title.length < 2) throw new AppError("VALIDATION", "Enter the title.");
    const year = Number(input.year) || null;
    const { parseName } = await import("@researchmate/citations");
    const item: CslItem = {
      id: "",
      type: input.type || "article-journal",
      title,
      author: input.authors ? input.authors.split(/;|\n|\band\b/).map((a) => a.trim()).filter(Boolean).map(parseName) : undefined,
      ...(year ? { issued: { "date-parts": [[year]] } } : {}),
      "container-title": input.containerTitle || undefined,
      volume: input.volume || undefined,
      issue: input.issue || undefined,
      page: input.pages || undefined,
      publisher: input.publisher || undefined,
      DOI: normalizeDoi(input.doi) ?? undefined,
      URL: input.url || undefined,
    };
    const r = await this.addItems(actorUserId, projectId, [Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as CslItem], { provider: "manual", status: "unverified" });
    if (!r.added[0]) throw new AppError("CONFLICT", "That reference is already in the library.");
    return r.added[0];
  }

  async importText(actorUserId: string, projectId: string, format: "bibtex" | "ris", text: string) {
    if (text.length > 2_000_000) throw new AppError("VALIDATION", "The file is too large to import (2 MB maximum).");
    const parsed = format === "bibtex" ? parseBibtex(text) : parseRis(text);
    if (!parsed.items.length) throw new AppError("VALIDATION", parsed.errors[0] ?? "No references were found in that file.");
    const r = await this.addItems(actorUserId, projectId, parsed.items, { provider: format, status: "unverified" });
    return { added: r.added.length, duplicates: r.duplicates.length, errors: parsed.errors };
  }

  async exportText(actorUserId: string, projectId: string, format: "bibtex" | "ris") {
    const refs = await this.list(actorUserId, projectId);
    const items = refs.map((r) => ({ ...(r.csl as object), id: r.citationKey }) as CslItem);
    return format === "bibtex" ? toBibtex(items) : toRis(items);
  }

  async remove(actorUserId: string, referenceId: string) {
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    const access = await this.guard(actorUserId, r.projectId, true);
    const [used] = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from document_citations where reference_id = ${referenceId}`).catch(() => [{ n: 0 }]);
    if (Number(used?.n ?? 0) > 0) throw new AppError("CONFLICT", "This reference is cited in a document. Remove the citations first.");
    await this.db.delete(references).where(eq(references.id, referenceId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "reference.deleted", targetType: "project", targetId: r.projectId, metadata: { key: r.citationKey } });
  }

  // ----- Verification ------------------------------------------------------

  /**
   * Checks a reference against the DOI registry (Crossref / doi.org). Title
   * and year must match the registry record; authors are compared by family
   * name. Never upgrades beyond metadata_verified.
   */
  async verify(actorUserId: string, referenceId: string) {
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    await this.guard(actorUserId, r.projectId, true);
    if (!r.doi) throw new AppError("VALIDATION", "Add a DOI to verify this reference against the DOI registry.");
    const found = await this.deps.scholarly.resolveDoi(r.doi);
    const issues: string[] = [];
    if (!found) issues.push("The DOI was not found in the registry.");
    else {
      const a = normTitle(r.title);
      const b = normTitle(found.title);
      if (a !== b && !(a.length > 20 && (b.startsWith(a) || a.startsWith(b)))) issues.push(`Title differs from the registry: “${found.title}”.`);
      if (r.year && found.year && Math.abs(r.year - found.year) > 1) issues.push(`Year differs: registry says ${found.year}.`);
      const fam = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
      if (r.firstAuthor && found.authors[0] && fam(found.authors[0].family ?? found.authors[0].literal) && fam(r.firstAuthor) !== fam(found.authors[0].family ?? found.authors[0].literal)) issues.push(`First author differs: registry says ${found.authors[0].family ?? found.authors[0].literal}.`);
    }
    const ok = issues.length === 0;
    const current = ORDER.indexOf(r.verificationStatus);
    const next = ok ? (current >= ORDER.indexOf("metadata_verified") ? r.verificationStatus : "metadata_verified") : "verification_failed";
    await this.db.update(references).set({ verificationStatus: next, retrievedAt: new Date(), updatedAt: new Date() }).where(eq(references.id, referenceId));
    await this.event(referenceId, r.verificationStatus, next, "doi_registry", actorUserId, { issues, registryTitle: found?.title ?? null });
    return { status: next, issues, registry: found };
  }

  /** Attaches the full text (a project file). This is "retrieved", not "reviewed". */
  async attachFullText(actorUserId: string, referenceId: string, fileId: string) {
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    await this.guard(actorUserId, r.projectId, true);
    const [f] = await this.db.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt)));
    if (!f || f.projectId !== r.projectId) throw new AppError("VALIDATION", "Choose a file uploaded to this project.");
    const next = ORDER.indexOf(r.verificationStatus) >= ORDER.indexOf("full_text_retrieved") ? r.verificationStatus : "full_text_retrieved";
    await this.db.update(references).set({ fileId, accessLevel: "full_text", verificationStatus: next, updatedAt: new Date() }).where(eq(references.id, referenceId));
    await this.event(referenceId, r.verificationStatus, next, "full_text_attached", actorUserId, { fileId });
  }

  /** A person confirms they have read the full text. Requires the full text to be attached. */
  async markReviewed(actorUserId: string, referenceId: string) {
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    await this.guard(actorUserId, r.projectId, true);
    if (!r.fileId || r.accessLevel !== "full_text") throw new AppError("VALIDATION", "Attach the full text before marking it reviewed.");
    await this.db.update(references).set({ verificationStatus: "full_text_reviewed", updatedAt: new Date() }).where(eq(references.id, referenceId));
    await this.event(referenceId, r.verificationStatus, "full_text_reviewed", "human_review", actorUserId);
  }

  /** Possible duplicates already in the library (same DOI or same normalised title). */
  async duplicates(actorUserId: string, projectId: string) {
    const refs = await this.list(actorUserId, projectId);
    const groups = new Map<string, Ref[]>();
    for (const r of refs) for (const k of [r.doi ? `doi:${r.doi}` : null, `t:${normTitle(r.title)}`].filter(Boolean) as string[]) groups.set(k, [...(groups.get(k) ?? []), r]);
    const seen = new Set<string>();
    return [...groups.values()].filter((g) => g.length > 1).filter((g) => {
      const sig = g.map((r) => r.id).sort().join(",");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  // ----- Scholarly search --------------------------------------------------

  async search(actorUserId: string, projectId: string, provider: ProviderKey, query: string, cursor?: string | null) {
    const access = await this.guard(actorUserId, projectId, false);
    const ent = await getEntitlements(this.db, access.organizationId);
    if (tierOf(ent, "research.web") === "none") throw new AppError("FEATURE_NOT_ENTITLED", `Scholarly search is not included in the ${ent.planName} plan.`, { feature: "research.web" });
    if (!(provider in PROVIDERS)) throw new AppError("VALIDATION", "Unknown source.");
    if (query.trim().length < 2) throw new AppError("VALIDATION", "Enter search terms.");
    try {
      const page = await this.deps.scholarly.search(provider, query, { cursor });
      const inLibrary = await this.db.select({ doi: references.doi }).from(references).where(eq(references.projectId, projectId));
      const have = new Set(inLibrary.map((r) => r.doi).filter(Boolean));
      return { ...page, records: page.records.map((r) => ({ ...r, inLibrary: !!r.doi && have.has(r.doi) })) };
    } catch (err) {
      logger.warn("scholarly.search_failed", { provider, error: String(err) });
      throw new AppError("VALIDATION", (err as Error).message || `${PROVIDERS[provider]} couldn't be reached.`);
    }
  }

  // ----- Themes, evidence, matrix -----------------------------------------

  async themes(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, false);
    return this.db.select().from(researchThemes).where(eq(researchThemes.projectId, projectId)).orderBy(asc(researchThemes.sortOrder), asc(researchThemes.name));
  }

  async addTheme(actorUserId: string, projectId: string, name: string, description = "") {
    await this.guard(actorUserId, projectId, true);
    const n = name.trim();
    if (n.length < 2 || n.length > 120) throw new AppError("VALIDATION", "Theme names need 2–120 characters.");
    const [row] = await this.db.insert(researchThemes).values({ projectId, name: n, description: description.slice(0, 1000) }).onConflictDoNothing().returning();
    if (!row) throw new AppError("CONFLICT", "That theme already exists.");
    return row;
  }

  private async assertInProject(projectId: string, refs: { referenceId?: string | null; fileId?: string | null; researchQuestionId?: string | null; themeId?: string | null }) {
    const checks: [string | null | undefined, string][] = [
      [refs.referenceId, "references"],
      [refs.fileId, "files"],
      [refs.researchQuestionId, "research_questions"],
      [refs.themeId, "research_themes"],
    ];
    for (const [id, table] of checks) {
      if (!id) continue;
      const rows = await this.db.execute<{ ok: number }>(sql`select 1 as ok from ${sql.identifier(table)} where id = ${id} and project_id = ${projectId}`);
      if (!rows.length) throw new AppError("VALIDATION", "A linked item belongs to another project.");
    }
  }

  async listEvidence(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, false);
    return this.db
      .select({ e: evidenceRecords, citationKey: references.citationKey, refTitle: references.title, theme: researchThemes.name, question: researchQuestions.text })
      .from(evidenceRecords)
      .leftJoin(references, eq(references.id, evidenceRecords.referenceId))
      .leftJoin(researchThemes, eq(researchThemes.id, evidenceRecords.themeId))
      .leftJoin(researchQuestions, eq(researchQuestions.id, evidenceRecords.researchQuestionId))
      .where(eq(evidenceRecords.projectId, projectId))
      .orderBy(desc(evidenceRecords.createdAt));
  }

  async addEvidence(actorUserId: string, projectId: string, input: unknown, method: "manual" | "ai" = "manual") {
    const d = parse(evidenceSchema, input);
    await this.guard(actorUserId, projectId, true);
    await this.assertInProject(projectId, d);
    if (!d.referenceId && !d.fileId) throw new AppError("VALIDATION", "Link the evidence to a reference or a file, so it can be traced.");
    const [row] = await this.db
      .insert(evidenceRecords)
      // Always a person's decision: AI-extracted evidence only arrives here when a user accepts the suggestion.
      .values({ ...d, projectId, extractionMethod: method, reviewStatus: "accepted", createdByUserId: actorUserId })
      .returning();
    return row!;
  }

  async updateEvidence(actorUserId: string, evidenceId: string, input: Record<string, unknown>) {
    const [e] = await this.db.select().from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId));
    if (!e) throw new AppError("NOT_FOUND", "Evidence not found.");
    await this.guard(actorUserId, e.projectId, true);
    const patch = parse(
      evidenceSchema.partial().extend({ verificationStatus: z.enum(["unverified", "verified", "disputed"]).optional(), reviewStatus: z.enum(["pending", "accepted", "rejected"]).optional() }),
      input,
    );
    await this.assertInProject(e.projectId, patch);
    await this.db.update(evidenceRecords).set({ ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: new Date() }).where(eq(evidenceRecords.id, evidenceId));
  }

  async deleteEvidence(actorUserId: string, evidenceId: string) {
    const [e] = await this.db.select().from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId));
    if (!e) throw new AppError("NOT_FOUND", "Evidence not found.");
    await this.guard(actorUserId, e.projectId, true);
    await this.db.delete(evidenceRecords).where(eq(evidenceRecords.id, evidenceId));
  }

  async matrix(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, false);
    const [refs, entries] = await Promise.all([
      this.db.select().from(references).where(eq(references.projectId, projectId)).orderBy(asc(references.year), asc(references.firstAuthor)),
      this.db.select().from(literatureMatrixEntries).where(eq(literatureMatrixEntries.projectId, projectId)),
    ]);
    const byRef = new Map(entries.map((e) => [e.referenceId, e]));
    return refs.map((r) => ({ reference: r, entry: byRef.get(r.id) ?? null }));
  }

  /**
   * Saves a matrix row. The basis can't claim more than the content held: a
   * reference with only metadata can't have an entry "from the full text".
   */
  async saveMatrixEntry(actorUserId: string, referenceId: string, input: unknown, source: "manual" | "ai" = "manual") {
    const d = parse(matrixSchema, input);
    const [r] = await this.db.select().from(references).where(eq(references.id, referenceId));
    if (!r) throw new AppError("NOT_FOUND", "Reference not found.");
    await this.guard(actorUserId, r.projectId, true);
    if (ACCESS_RANK[d.basis] > ACCESS_RANK[r.accessLevel as keyof typeof ACCESS_RANK]) throw new AppError("VALIDATION", `This reference only has its ${r.accessLevel === "metadata" ? "bibliographic details" : "abstract"} on file, so the entry can't be based on more than that.`);
    const values = { ...d, referenceId, projectId: r.projectId, source, updatedByUserId: actorUserId, updatedAt: new Date() };
    await this.db.insert(literatureMatrixEntries).values(values).onConflictDoUpdate({ target: literatureMatrixEntries.referenceId, set: values });
  }

  // ----- Text extraction and search ---------------------------------------

  /** Queues extraction for a stored file version (called after upload when processing is allowed). */
  async queueExtraction(fileId: string, version: number, mimeType: string, aiProcessingAllowed: boolean) {
    if (!aiProcessingAllowed || !EXTRACTABLE.has(mimeType)) return null;
    const [job] = await this.db.insert(fileProcessingJobs).values({ fileId, fileVersion: version, jobType: "extract_text" }).returning();
    await this.db.update(files).set({ processingStatus: "pending" }).where(eq(files.id, fileId));
    await this.deps.enqueueExtraction?.(job!.id);
    return job!;
  }

  async processExtraction(jobId: string) {
    const [job] = await this.db.select().from(fileProcessingJobs).where(eq(fileProcessingJobs.id, jobId));
    if (!job || job.status === "succeeded") return;
    if (!this.deps.driver) throw new Error("Storage driver required for extraction");
    await this.db.update(fileProcessingJobs).set({ status: "running", attempts: sql`${fileProcessingJobs.attempts} + 1`, updatedAt: new Date() }).where(eq(fileProcessingJobs.id, jobId));
    await this.db.update(files).set({ processingStatus: "processing" }).where(eq(files.id, job.fileId));
    try {
      const [f] = await this.db.select().from(files).where(eq(files.id, job.fileId));
      const [v] = await this.db.select().from(fileVersions).where(and(eq(fileVersions.fileId, job.fileId), eq(fileVersions.version, job.fileVersion)));
      if (!f || !v || f.deletedAt) throw new Error("File no longer available");
      const chunks: Buffer[] = [];
      for await (const c of await this.deps.driver.get(v.storageKey)) chunks.push(Buffer.from(c as Buffer));
      const pages = await extractText(Buffer.concat(chunks), f.mimeType, { ocr: this.deps.ocr });
      await this.db.transaction(async (tx) => {
        await tx.delete(filePassages).where(and(eq(filePassages.fileId, job.fileId), eq(filePassages.fileVersion, job.fileVersion)));
        const rows = pages.filter((p) => p.text).flatMap((p) => splitText(p.text, 4000).map((text, seq) => ({ fileId: job.fileId, fileVersion: job.fileVersion, page: p.page, seq, text, method: p.method })));
        for (let i = 0; i < rows.length; i += 200) await tx.insert(filePassages).values(rows.slice(i, i + 200));
        await tx.update(fileProcessingJobs).set({ status: "succeeded", error: null, updatedAt: new Date() }).where(eq(fileProcessingJobs.id, jobId));
        await tx.update(files).set({ processingStatus: "processed" }).where(eq(files.id, job.fileId));
        // OCR is an external-service cost, metered separately from AI (charged only if priced).
        const ocrPages = pages.filter((p) => p.method === "ocr").length;
        if (ocrPages) await new LedgerService(this.db).meterService(tx, { organizationId: f.organizationId, projectId: f.projectId, userId: f.uploadedByUserId, serviceKey: "ocr.pages", quantity: ocrPages, unit: "page", sourceType: "file_processing_job", sourceId: jobId });
      });
    } catch (err) {
      logger.warn("extraction.failed", { jobId, error: String(err) });
      await this.db.update(fileProcessingJobs).set({ status: "failed", error: String((err as Error).message ?? err).slice(0, 500), updatedAt: new Date() }).where(eq(fileProcessingJobs.id, jobId));
      await this.db.update(files).set({ processingStatus: "failed" }).where(eq(files.id, job.fileId));
    }
  }

  private async filesGuard(actorUserId: string, projectId: string) {
    const access = await this.guard(actorUserId, projectId, false);
    if (!access.permissions.has("project.files.read")) throw new AppError("FORBIDDEN", "You don't have access to this project's files.");
  }

  /** Full-text search across the project's extracted documents, with page numbers for traceability. */
  async searchPassages(actorUserId: string, projectId: string, query: string, limit = 30) {
    await this.filesGuard(actorUserId, projectId);
    if (query.trim().length < 2) return [];
    const tsq = sql`websearch_to_tsquery('english', ${query.trim()})`;
    return this.db
      .select({
        fileId: filePassages.fileId,
        fileName: files.originalName,
        page: filePassages.page,
        method: filePassages.method,
        snippet: sql<string>`ts_headline('english', ${filePassages.text}, ${tsq}, 'MaxFragments=2, MaxWords=30, MinWords=12, StartSel=«, StopSel=»')`,
        rank: sql<number>`ts_rank(${filePassages.search}, ${tsq})`,
      })
      .from(filePassages)
      .innerJoin(files, and(eq(files.id, filePassages.fileId), eq(files.currentVersion, filePassages.fileVersion)))
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), sql`${filePassages.search} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${filePassages.search}, ${tsq})`))
      .limit(limit);
  }

  async passagesFor(actorUserId: string, projectId: string, fileId: string, maxChars = 60_000) {
    await this.filesGuard(actorUserId, projectId);
    const rows = await this.db.select().from(filePassages).innerJoin(files, eq(files.id, filePassages.fileId)).where(and(eq(filePassages.fileId, fileId), eq(files.projectId, projectId), eq(files.currentVersion, filePassages.fileVersion))).orderBy(asc(filePassages.page), asc(filePassages.seq));
    let total = 0;
    return rows.map((r) => r.file_passages).filter((p) => (total += p.text.length) <= maxChars);
  }

  async referencesByIds(projectId: string, ids: string[]) {
    return ids.length ? this.db.select().from(references).where(and(eq(references.projectId, projectId), inArray(references.id, ids))) : [];
  }
}

function splitText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
