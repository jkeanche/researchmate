import {
  type Database,
  documentCitations,
  documentComments,
  documentExports,
  documents,
  documentSections,
  documentSectionEvidence,
  type DocumentSpec,
  documentSpecificationVersions,
  documentTemplates,
  documentValidationResults,
  documentVersions,
  evidenceRecords,
  files,
  fileVersions,
  references,
  userProfiles,
} from "@researchmate/database";
import { getEntitlements, tierOf } from "@researchmate/entitlements";
import { assertProjectWritable } from "@researchmate/research";
import { AppError, logger } from "@researchmate/shared";
import type { StorageDriver } from "@researchmate/storage";
import { getProjectAccess, notify, recordAudit } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { buildDocx, type FigureData, imageSize } from "./docx";
import { parseMarkup } from "./markup";
import { assemble, type RefInput, type SectionInput } from "./model";
import { docxToPdf, inspectPdf } from "./pdf";
import { specSchema } from "./spec";
import { validateDocument } from "./validate";

type Doc = typeof documents.$inferSelect;
type Section = typeof documentSections.$inferSelect;

export interface DocumentDeps {
  driver?: StorageDriver;
  enqueueExport?: (exportId: string) => Promise<void>;
  /** How many finished exports to keep per document (older files are deleted). */
  keepExports?: number;
}

const META_KEYS = ["author", "subtitle", "degree", "documentLabel", "department", "institution", "supervisor", "date"] as const;
const metaSchema = z.object(Object.fromEntries(META_KEYS.map((k) => [k, z.string().trim().max(300).optional()]))).strip();
const MAX_FIGURE_BYTES = 25 * 1024 * 1024;
const MAX_EXPORT_BYTES = 300 * 1024 * 1024;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "section";

export class DocumentService {
  constructor(
    private readonly db: Database,
    private readonly deps: DocumentDeps = {},
  ) {}

  // ----- Access ------------------------------------------------------------

  private async access(actorUserId: string, projectId: string, need: "read" | "write" | "comment") {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const p = access.permissions;
    // Documents are research content: finance-only roles don't see them.
    if (!p.has("project.files.read") && !p.has("project.review") && !p.has("project.update")) throw new AppError("NOT_FOUND", "Project not found.");
    if (need === "write") {
      if (!p.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to change documents.");
      await assertProjectWritable(this.db, projectId);
    }
    if (need === "comment") {
      if (!p.has("project.update") && !p.has("project.review")) throw new AppError("FORBIDDEN", "You can't comment on this project's documents.");
      await assertProjectWritable(this.db, projectId);
    }
    return access;
  }

  private async loadDoc(documentId: string): Promise<Doc> {
    const [d] = await this.db.select().from(documents).where(eq(documents.id, documentId));
    if (!d) throw new AppError("NOT_FOUND", "Document not found.");
    return d;
  }

  private async docFor(actorUserId: string, documentId: string, need: "read" | "write" | "comment") {
    const doc = await this.loadDoc(documentId);
    const access = await this.access(actorUserId, doc.projectId, need);
    return { doc, access };
  }

  // ----- Templates and documents -------------------------------------------

  async templates() {
    return this.db.select().from(documentTemplates).where(eq(documentTemplates.active, true)).orderBy(asc(documentTemplates.name));
  }

  async list(actorUserId: string, projectId: string) {
    await this.access(actorUserId, projectId, "read");
    return this.db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(desc(documents.updatedAt));
  }

  async create(actorUserId: string, projectId: string, input: { templateKey: string; title: string; meta?: Record<string, unknown> }) {
    const access = await this.access(actorUserId, projectId, "write");
    const title = String(input.title ?? "").trim();
    if (title.length < 2 || title.length > 300) throw new AppError("VALIDATION", "Give the document a title (2–300 characters).");
    const [tpl] = await this.db.select().from(documentTemplates).where(and(eq(documentTemplates.key, input.templateKey), eq(documentTemplates.active, true))).orderBy(desc(documentTemplates.version)).limit(1);
    if (!tpl) throw new AppError("VALIDATION", "Choose a template.");
    const spec = tpl.spec as unknown as DocumentSpec;
    const meta = metaSchema.parse(input.meta ?? {}) as Record<string, string>;
    return this.db.transaction(async (tx) => {
      const [doc] = await tx.insert(documents).values({ projectId, title, documentType: tpl.documentType, templateKey: tpl.key, templateVersion: tpl.version, meta, createdByUserId: actorUserId }).returning();
      await tx.insert(documentSpecificationVersions).values({ projectId, documentId: doc!.id, version: 1, spec: spec as unknown as Record<string, unknown>, note: `From template “${tpl.name}” v${tpl.version}`, createdByUserId: actorUserId });
      await tx.insert(documentSections).values(spec.sections.map((s, i) => ({ documentId: doc!.id, key: s.key, title: s.title, kind: s.kind, required: s.required, sortOrder: (i + 1) * 10, wordLimit: s.wordLimit ?? null, guidance: s.guidance ?? "", updatedByUserId: actorUserId })));
      await recordAudit(tx, { organizationId: access.organizationId, actorUserId, action: "document.created", targetType: "project", targetId: projectId, metadata: { documentId: doc!.id, template: tpl.key } });
      return doc!;
    });
  }

  async get(actorUserId: string, documentId: string) {
    const { doc, access } = await this.docFor(actorUserId, documentId, "read");
    const [spec, sections] = await Promise.all([this.currentSpec(doc), this.db.select().from(documentSections).where(eq(documentSections.documentId, documentId)).orderBy(asc(documentSections.sortOrder))]);
    const p = access.permissions;
    return { document: doc, spec, sections, canEdit: p.has("project.update"), canComment: p.has("project.update") || p.has("project.review"), organizationId: access.organizationId };
  }

  private async currentSpec(doc: Doc): Promise<DocumentSpec> {
    const [v] = await this.db.select({ spec: documentSpecificationVersions.spec }).from(documentSpecificationVersions).where(and(eq(documentSpecificationVersions.documentId, doc.id), eq(documentSpecificationVersions.version, doc.specVersion)));
    return v!.spec as unknown as DocumentSpec;
  }

  async updateDetails(actorUserId: string, documentId: string, input: { title?: string; meta?: Record<string, unknown>; status?: string }) {
    const { doc } = await this.docFor(actorUserId, documentId, "write");
    const patch: Partial<Doc> = { updatedAt: new Date() };
    if (input.title !== undefined) {
      const t = input.title.trim();
      if (t.length < 2 || t.length > 300) throw new AppError("VALIDATION", "Titles need 2–300 characters.");
      patch.title = t;
    }
    if (input.meta) patch.meta = { ...doc.meta, ...(metaSchema.parse(input.meta) as Record<string, string>) };
    if (input.status) {
      if (!["draft", "in_review", "final"].includes(input.status)) throw new AppError("VALIDATION", "Unknown status.");
      patch.status = input.status;
    }
    await this.db.update(documents).set(patch).where(eq(documents.id, documentId));
  }

  /** Formatting, limits and citation style. Each change is a new specification version; history is kept. */
  async updateSpec(actorUserId: string, documentId: string, changes: Partial<DocumentSpec>, note = "") {
    const { doc } = await this.docFor(actorUserId, documentId, "write");
    const current = await this.currentSpec(doc);
    const merged = { ...current, ...changes, sections: current.sections } as DocumentSpec;
    const parsed = specSchema.safeParse(merged);
    if (!parsed.success) throw new AppError("VALIDATION", `${parsed.error.issues[0]!.path.join(".")}: ${parsed.error.issues[0]!.message}`);
    if (parsed.data.limits.minWords && parsed.data.limits.maxWords && parsed.data.limits.minWords > parsed.data.limits.maxWords) throw new AppError("VALIDATION", "The minimum word count is above the maximum.");
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ specVersion: documents.specVersion }).from(documents).where(eq(documents.id, documentId)).for("update");
      const version = locked!.specVersion + 1;
      await tx.insert(documentSpecificationVersions).values({ projectId: doc.projectId, documentId, version, spec: parsed.data as unknown as Record<string, unknown>, note: note.slice(0, 300), createdByUserId: actorUserId });
      await tx.update(documents).set({ specVersion: version, updatedAt: new Date() }).where(eq(documents.id, documentId));
      return version;
    });
  }

  async specHistory(actorUserId: string, documentId: string) {
    await this.docFor(actorUserId, documentId, "read");
    return this.db.select({ version: documentSpecificationVersions.version, note: documentSpecificationVersions.note, createdAt: documentSpecificationVersions.createdAt, by: userProfiles.displayName }).from(documentSpecificationVersions).leftJoin(userProfiles, eq(userProfiles.userId, documentSpecificationVersions.createdByUserId)).where(eq(documentSpecificationVersions.documentId, documentId)).orderBy(desc(documentSpecificationVersions.version));
  }

  async remove(actorUserId: string, documentId: string) {
    const { doc, access } = await this.docFor(actorUserId, documentId, "write");
    const keys = await this.db.select({ k: documentExports.storageKey }).from(documentExports).where(eq(documentExports.documentId, documentId));
    await this.db.delete(documents).where(eq(documents.id, documentId));
    for (const { k } of keys) if (k) await this.deps.driver?.delete(k).catch(() => {});
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "document.deleted", targetType: "project", targetId: doc.projectId, metadata: { documentId, title: doc.title } });
  }

  // ----- Sections ----------------------------------------------------------

  private async sectionFor(actorUserId: string, sectionId: string, need: "read" | "write" | "comment") {
    const [s] = await this.db.select().from(documentSections).where(eq(documentSections.id, sectionId));
    if (!s) throw new AppError("NOT_FOUND", "Section not found.");
    const r = await this.docFor(actorUserId, s.documentId, need);
    return { section: s, ...r };
  }

  /** Saves a section's text with optimistic concurrency and rebuilds its citation index. */
  async saveSection(actorUserId: string, sectionId: string, input: { content: string; version: number }) {
    const { section, doc } = await this.sectionFor(actorUserId, sectionId, "write");
    if (["title", "toc", "references"].includes(section.kind)) throw new AppError("VALIDATION", "This section is generated automatically.");
    const content = String(input.content ?? "");
    if (content.length > 400_000) throw new AppError("VALIDATION", "A section can hold up to 400,000 characters. Split it into more sections.");
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(documentSections)
        .set({ content, version: sql`${documentSections.version} + 1`, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(and(eq(documentSections.id, sectionId), eq(documentSections.version, Number(input.version))))
        .returning();
      if (!row) throw new AppError("CONFLICT", "Someone else saved this section since you opened it. Copy your changes, reload, and apply them again.");
      await this.indexCitations(tx as unknown as Database, doc, row);
      await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
      return row;
    });
  }

  private async indexCitations(db: Database, doc: Doc, section: Section) {
    await db.delete(documentCitations).where(eq(documentCitations.sectionId, section.id));
    const parsed = parseMarkup(section.content);
    const items = parsed.clusters.flatMap((c) => c);
    if (!items.length) return;
    const keys = [...new Set(items.map((i) => i.key))];
    const refs = await db.select({ id: references.id, key: references.citationKey }).from(references).where(and(eq(references.projectId, doc.projectId), inArray(references.citationKey, keys)));
    const byKey = new Map(refs.map((r) => [r.key, r.id]));
    await db.insert(documentCitations).values(items.map((it, n) => ({ documentId: doc.id, sectionId: section.id, referenceId: byKey.get(it.key) ?? null, citationKey: it.key, locator: it.locator ?? null, ordinal: n })));
  }

  async addSection(actorUserId: string, documentId: string, input: { title: string; kind: string; afterSectionId?: string | null }) {
    await this.docFor(actorUserId, documentId, "write");
    const title = String(input.title ?? "").trim();
    if (title.length < 1 || title.length > 200) throw new AppError("VALIDATION", "Give the section a title.");
    if (!["front", "body", "appendix"].includes(input.kind)) throw new AppError("VALIDATION", "Choose preliminary, main text or appendix.");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from documents where id = ${documentId} for update`);
      const all = await tx.select().from(documentSections).where(eq(documentSections.documentId, documentId)).orderBy(asc(documentSections.sortOrder));
      const taken = new Set(all.map((s) => s.key));
      let key = slug(title);
      for (let n = 2; taken.has(key); n++) key = `${slug(title).slice(0, 32)}_${n}`;
      const after = input.afterSectionId ? all.find((s) => s.id === input.afterSectionId) : [...all].reverse().find((s) => s.kind === input.kind) ?? all.find((s) => s.kind === "references");
      const pos = after ? all.indexOf(after) + 1 : all.length;
      const ordered = [...all.slice(0, pos), null, ...all.slice(pos)];
      for (const [i, s] of ordered.entries()) if (s && s.sortOrder !== (i + 1) * 10) await tx.update(documentSections).set({ sortOrder: (i + 1) * 10 }).where(eq(documentSections.id, s.id));
      const [row] = await tx.insert(documentSections).values({ documentId, key, title, kind: input.kind, required: false, sortOrder: (pos + 1) * 10, updatedByUserId: actorUserId }).returning();
      return row!;
    });
  }

  async renameSection(actorUserId: string, sectionId: string, title: string, wordLimit?: number | null) {
    const { section } = await this.sectionFor(actorUserId, sectionId, "write");
    const t = title.trim();
    if (t.length < 1 || t.length > 200) throw new AppError("VALIDATION", "Give the section a title.");
    if (wordLimit !== undefined && wordLimit !== null && (!Number.isInteger(wordLimit) || wordLimit < 1 || wordLimit > 500_000)) throw new AppError("VALIDATION", "Word limits must be a whole number.");
    await this.db.update(documentSections).set({ title: t, ...(wordLimit !== undefined ? { wordLimit } : {}), updatedAt: new Date() }).where(eq(documentSections.id, section.id));
  }

  async removeSection(actorUserId: string, sectionId: string) {
    const { section } = await this.sectionFor(actorUserId, sectionId, "write");
    if (section.required) throw new AppError("VALIDATION", "This section is required by the document's specification.");
    if (section.content.trim()) throw new AppError("VALIDATION", "Empty the section before removing it (its text stays in saved versions).");
    await this.db.delete(documentSections).where(eq(documentSections.id, sectionId));
  }

  async moveSection(actorUserId: string, sectionId: string, direction: "up" | "down") {
    const { section } = await this.sectionFor(actorUserId, sectionId, "write");
    await this.db.transaction(async (tx) => {
      const all = await tx.select().from(documentSections).where(eq(documentSections.documentId, section.documentId)).orderBy(asc(documentSections.sortOrder)).for("update");
      const i = all.findIndex((s) => s.id === sectionId);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= all.length) return;
      // Generated sections keep their place relative to the kinds around them.
      if (all[j]!.kind !== section.kind) throw new AppError("VALIDATION", "Sections can only be moved among sections of the same kind.");
      await tx.update(documentSections).set({ sortOrder: all[j]!.sortOrder }).where(eq(documentSections.id, all[i]!.id));
      await tx.update(documentSections).set({ sortOrder: all[i]!.sortOrder }).where(eq(documentSections.id, all[j]!.id));
    });
  }

  // ----- Assembly, preview and audit ---------------------------------------

  private async refInputs(projectId: string): Promise<RefInput[]> {
    const rows = await this.db.select().from(references).where(eq(references.projectId, projectId));
    return rows.map((r) => ({ id: r.id, key: r.citationKey, csl: r.csl, verificationStatus: r.verificationStatus, accessLevel: r.accessLevel }));
  }

  private toInputs(sections: Pick<Section, "id" | "key" | "title" | "kind" | "content" | "required" | "wordLimit">[]): SectionInput[] {
    return sections.map((s) => ({ id: s.id, key: s.key, title: s.title, kind: s.kind as SectionInput["kind"], content: s.content, required: s.required, wordLimit: s.wordLimit }));
  }

  /** The assembled model for the browser preview and live checks (content checks only). */
  async preview(actorUserId: string, documentId: string) {
    const { document, spec, sections } = await this.get(actorUserId, documentId);
    const refs = await this.refInputs(document.projectId);
    const model = assemble(spec, this.toInputs(sections), refs, "html");
    const checks = validateDocument({ spec, model, refStatus: new Map(refs.map((r) => [r.key, r])), missingFigures: [] });
    return { document, spec, model, checks };
  }

  /** The assembled model of a saved version, with the specification it was saved under. */
  async previewVersion(actorUserId: string, versionId: string) {
    const v = await this.version(actorUserId, versionId);
    const doc = await this.loadDoc(v.documentId);
    const [specRow] = await this.db.select().from(documentSpecificationVersions).where(and(eq(documentSpecificationVersions.documentId, doc.id), eq(documentSpecificationVersions.version, v.specVersion)));
    const spec = specRow!.spec as unknown as DocumentSpec;
    const sections: SectionInput[] = v.snapshot.sections.map((s, i) => ({ id: `${v.id}:${i}`, key: s.key, title: s.title, kind: s.kind as SectionInput["kind"], content: s.content, required: (s as { required?: boolean }).required ?? false, wordLimit: (s as { wordLimit?: number | null }).wordLimit ?? null }));
    const refs = await this.refInputs(doc.projectId);
    const model = assemble(spec, sections, refs, "html");
    return { version: v, spec, model, checks: validateDocument({ spec, model, refStatus: new Map(refs.map((r) => [r.key, r])), missingFigures: [] }) };
  }

  /** Citation audit: every citation must point to a library record; flags weakly supported citations. */
  async audit(actorUserId: string, documentId: string) {
    const { doc } = await this.docFor(actorUserId, documentId, "read");
    const rows = await this.db
      .select({ key: documentCitations.citationKey, referenceId: documentCitations.referenceId, locator: documentCitations.locator, section: documentSections.title, sectionId: documentSections.id, title: references.title, status: references.verificationStatus, access: references.accessLevel, year: references.year })
      .from(documentCitations)
      .innerJoin(documentSections, eq(documentSections.id, documentCitations.sectionId))
      .leftJoin(references, eq(references.id, documentCitations.referenceId))
      .where(eq(documentCitations.documentId, documentId))
      .orderBy(asc(documentSections.sortOrder), asc(documentCitations.ordinal));
    // A citation saved before its reference was added is re-resolved here.
    const keys = [...new Set(rows.filter((r) => !r.referenceId).map((r) => r.key))];
    const late = keys.length ? await this.db.select().from(references).where(and(eq(references.projectId, doc.projectId), inArray(references.citationKey, keys))) : [];
    const lateBy = new Map(late.map((r) => [r.citationKey, r]));
    const cited = new Map<string, { key: string; referenceId: string | null; title: string | null; status: string | null; access: string | null; year: number | null; sections: string[]; count: number; locators: string[] }>();
    for (const r of rows) {
      const ref = r.referenceId ? r : lateBy.get(r.key) ? { referenceId: lateBy.get(r.key)!.id, title: lateBy.get(r.key)!.title, status: lateBy.get(r.key)!.verificationStatus, access: lateBy.get(r.key)!.accessLevel, year: lateBy.get(r.key)!.year } : r;
      const e = cited.get(r.key) ?? { key: r.key, referenceId: ref.referenceId, title: ref.title, status: ref.status, access: ref.access, year: ref.year, sections: [], count: 0, locators: [] };
      e.count++;
      if (!e.sections.includes(r.section)) e.sections.push(r.section);
      if (r.locator) e.locators.push(r.locator);
      cited.set(r.key, e);
    }
    const citedIds = [...cited.values()].map((c) => c.referenceId).filter(Boolean) as string[];
    const uncited = await this.db.select({ id: references.id, key: references.citationKey, title: references.title }).from(references).where(and(eq(references.projectId, doc.projectId), citedIds.length ? notInArray(references.id, citedIds) : sql`true`)).orderBy(asc(references.citationKey));
    // Evidence linked to a section whose source isn't cited there.
    const links = await this.db
      .select({ sectionId: documentSectionEvidence.sectionId, section: documentSections.title, key: references.citationKey, claim: evidenceRecords.claim })
      .from(documentSectionEvidence)
      .innerJoin(documentSections, eq(documentSections.id, documentSectionEvidence.sectionId))
      .innerJoin(evidenceRecords, eq(evidenceRecords.id, documentSectionEvidence.evidenceId))
      .leftJoin(references, eq(references.id, evidenceRecords.referenceId))
      .where(eq(documentSections.documentId, documentId));
    const citedIn = new Set(rows.map((r) => `${r.sectionId}|${r.key}`));
    const uncitedEvidence = links.filter((l) => l.key && !citedIn.has(`${l.sectionId}|${l.key}`));
    const list = [...cited.values()];
    return {
      citations: list,
      unknown: list.filter((c) => !c.referenceId),
      failed: list.filter((c) => c.status === "verification_failed"),
      unverified: list.filter((c) => c.status === "unverified" || c.status === "metadata_retrieved"),
      metadataOnly: list.filter((c) => c.referenceId && c.access === "metadata"),
      uncited,
      uncitedEvidence,
      total: rows.length,
    };
  }

  // ----- Comments ----------------------------------------------------------

  async comments(actorUserId: string, documentId: string) {
    await this.docFor(actorUserId, documentId, "read");
    return this.db
      .select({ c: documentComments, author: userProfiles.displayName })
      .from(documentComments)
      .leftJoin(userProfiles, eq(userProfiles.userId, documentComments.authorUserId))
      .where(eq(documentComments.documentId, documentId))
      .orderBy(asc(documentComments.createdAt));
  }

  async addComment(actorUserId: string, documentId: string, input: { sectionId?: string | null; parentId?: string | null; quote?: string; body: string }) {
    await this.docFor(actorUserId, documentId, "comment");
    const body = String(input.body ?? "").trim();
    if (!body || body.length > 5000) throw new AppError("VALIDATION", "Write a comment (up to 5,000 characters).");
    if (input.sectionId) {
      const [s] = await this.db.select({ d: documentSections.documentId }).from(documentSections).where(eq(documentSections.id, input.sectionId));
      if (s?.d !== documentId) throw new AppError("VALIDATION", "That section belongs to another document.");
    }
    let sectionId = input.sectionId || null;
    if (input.parentId) {
      const [p] = await this.db.select().from(documentComments).where(eq(documentComments.id, input.parentId));
      if (p?.documentId !== documentId) throw new AppError("VALIDATION", "Reply to a comment on this document.");
      sectionId = p.sectionId;
    }
    const [row] = await this.db.insert(documentComments).values({ documentId, sectionId, parentId: input.parentId || null, quote: String(input.quote ?? "").slice(0, 1000), body, authorUserId: actorUserId }).returning();
    return row!;
  }

  async resolveComment(actorUserId: string, commentId: string, resolved = true) {
    const [c] = await this.db.select().from(documentComments).where(eq(documentComments.id, commentId));
    if (!c) throw new AppError("NOT_FOUND", "Comment not found.");
    await this.docFor(actorUserId, c.documentId, "comment");
    await this.db.update(documentComments).set(resolved ? { resolvedAt: new Date(), resolvedByUserId: actorUserId } : { resolvedAt: null, resolvedByUserId: null }).where(eq(documentComments.id, commentId));
  }

  // ----- Evidence links ----------------------------------------------------

  async sectionEvidence(actorUserId: string, documentId: string) {
    await this.docFor(actorUserId, documentId, "read");
    return this.db
      .select({ sectionId: documentSectionEvidence.sectionId, e: evidenceRecords, key: references.citationKey })
      .from(documentSectionEvidence)
      .innerJoin(documentSections, eq(documentSections.id, documentSectionEvidence.sectionId))
      .innerJoin(evidenceRecords, eq(evidenceRecords.id, documentSectionEvidence.evidenceId))
      .leftJoin(references, eq(references.id, evidenceRecords.referenceId))
      .where(eq(documentSections.documentId, documentId));
  }

  async linkEvidence(actorUserId: string, sectionId: string, evidenceId: string, link = true) {
    const { doc } = await this.sectionFor(actorUserId, sectionId, "write");
    if (!link) {
      await this.db.delete(documentSectionEvidence).where(and(eq(documentSectionEvidence.sectionId, sectionId), eq(documentSectionEvidence.evidenceId, evidenceId)));
      return;
    }
    const [e] = await this.db.select({ projectId: evidenceRecords.projectId }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId));
    if (e?.projectId !== doc.projectId) throw new AppError("VALIDATION", "Choose evidence from this project.");
    await this.db.insert(documentSectionEvidence).values({ sectionId, evidenceId, linkedByUserId: actorUserId }).onConflictDoNothing();
  }

  // ----- Versions ----------------------------------------------------------

  private async snapshot(tx: Database, doc: Doc, actorUserId: string, label: string) {
    await tx.execute(sql`select id from documents where id = ${doc.id} for update`);
    const sections = await tx.select().from(documentSections).where(eq(documentSections.documentId, doc.id)).orderBy(asc(documentSections.sortOrder));
    const [{ n }] = (await tx.execute<{ n: number }>(sql`select coalesce(max(number), 0)::int as n from document_versions where document_id = ${doc.id}`)) as unknown as [{ n: number }];
    const [fresh] = await tx.select().from(documents).where(eq(documents.id, doc.id));
    const words = sections.filter((s) => s.kind === "body").reduce((a, s) => a + assembleWords(s.content), 0);
    const [v] = await tx
      .insert(documentVersions)
      .values({
        projectId: doc.projectId,
        documentId: doc.id,
        number: n + 1,
        label: label.slice(0, 200),
        specVersion: fresh!.specVersion,
        snapshot: { title: fresh!.title, meta: fresh!.meta, sections: sections.map((s) => ({ key: s.key, title: s.title, kind: s.kind, content: s.content, required: s.required, wordLimit: s.wordLimit })) },
        wordCount: words,
        createdByUserId: actorUserId,
      })
      .returning();
    return v!;
  }

  async saveVersion(actorUserId: string, documentId: string, label: string) {
    const { doc } = await this.docFor(actorUserId, documentId, "write");
    return this.db.transaction((tx) => this.snapshot(tx as unknown as Database, doc, actorUserId, label.trim() || "Saved version"));
  }

  async versions(actorUserId: string, documentId: string) {
    await this.docFor(actorUserId, documentId, "read");
    return this.db
      .select({ id: documentVersions.id, number: documentVersions.number, label: documentVersions.label, wordCount: documentVersions.wordCount, specVersion: documentVersions.specVersion, createdAt: documentVersions.createdAt, by: userProfiles.displayName })
      .from(documentVersions)
      .leftJoin(userProfiles, eq(userProfiles.userId, documentVersions.createdByUserId))
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.number));
  }

  async version(actorUserId: string, versionId: string) {
    const [v] = await this.db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    if (!v) throw new AppError("NOT_FOUND", "Version not found.");
    await this.docFor(actorUserId, v.documentId, "read");
    return v;
  }

  /** Restores section text from a version. The current text is saved as a version first, so nothing is lost. */
  async restoreVersion(actorUserId: string, versionId: string) {
    const v = await this.version(actorUserId, versionId);
    const { doc } = await this.docFor(actorUserId, v.documentId, "write");
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await this.snapshot(db, doc, actorUserId, `Before restoring version ${v.number}`);
      const current = await tx.select().from(documentSections).where(eq(documentSections.documentId, doc.id));
      const byKey = new Map(current.map((s) => [s.key, s]));
      let order = Math.max(0, ...current.map((s) => s.sortOrder));
      for (const s of v.snapshot.sections) {
        const existing = byKey.get(s.key);
        let row: Section;
        if (existing) [row] = (await tx.update(documentSections).set({ content: s.content, title: s.title, version: sql`${documentSections.version} + 1`, updatedByUserId: actorUserId, updatedAt: new Date() }).where(eq(documentSections.id, existing.id)).returning()) as [Section];
        else [row] = (await tx.insert(documentSections).values({ documentId: doc.id, key: s.key, title: s.title, kind: s.kind, content: s.content, required: false, sortOrder: (order += 10), updatedByUserId: actorUserId }).returning()) as [Section];
        await this.indexCitations(db, doc, row);
      }
      await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
      return v.number;
    });
  }

  // ----- Export ------------------------------------------------------------

  async exports(actorUserId: string, documentId: string) {
    await this.docFor(actorUserId, documentId, "read");
    return this.db
      .select({ x: documentExports, number: documentVersions.number, validation: documentValidationResults })
      .from(documentExports)
      .innerJoin(documentVersions, eq(documentVersions.id, documentExports.versionId))
      .leftJoin(documentValidationResults, eq(documentValidationResults.exportId, documentExports.id))
      .where(eq(documentExports.documentId, documentId))
      .orderBy(desc(documentExports.createdAt))
      .limit(20);
  }

  async generationTier(organizationId: string) {
    const ent = await getEntitlements(this.db, organizationId);
    return { tier: tierOf(ent, "documents.generation"), planName: ent.planName };
  }

  /** Snapshots the document and queues DOCX or PDF generation. Unknown citations block export. */
  async requestExport(actorUserId: string, documentId: string, format: "docx" | "pdf") {
    const { doc, access } = await this.docFor(actorUserId, documentId, "write");
    if (format !== "docx" && format !== "pdf") throw new AppError("VALIDATION", "Choose DOCX or PDF.");
    const { tier, planName } = await this.generationTier(access.organizationId);
    if (tier === "none") throw new AppError("FEATURE_NOT_ENTITLED", `Document export is not included in the ${planName} plan.`, { feature: "documents.generation" });
    const sections = await this.db.select().from(documentSections).where(eq(documentSections.documentId, documentId));
    const keys = [...new Set(sections.flatMap((s) => parseMarkup(s.content).clusters.flat().map((i) => i.key)))];
    if (keys.length) {
      const known = new Set((await this.db.select({ k: references.citationKey }).from(references).where(and(eq(references.projectId, doc.projectId), inArray(references.citationKey, keys)))).map((r) => r.k));
      const unknown = keys.filter((k) => !known.has(k));
      if (unknown.length) throw new AppError("VALIDATION", `These citations don't match any source in the library: ${unknown.slice(0, 8).map((k) => `@${k}`).join(", ")}. Add the sources or fix the keys before exporting.`);
    }
    const running = await this.db.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.documentId, documentId), inArray(documentExports.status, ["queued", "running"])));
    if (running.length >= 3) throw new AppError("RATE_LIMITED", "Exports for this document are already in progress. Wait for them to finish.");
    const row = await this.db.transaction(async (tx) => {
      const v = await this.snapshot(tx as unknown as Database, doc, actorUserId, `${format.toUpperCase()} export`);
      const [x] = await tx.insert(documentExports).values({ documentId, versionId: v.id, format, requestedByUserId: actorUserId }).returning();
      return x!;
    });
    await this.deps.enqueueExport?.(row.id);
    return row;
  }

  private async loadFigures(projectId: string, ids: string[]): Promise<Map<string, FigureData | null>> {
    const out = new Map<string, FigureData | null>();
    const unique = [...new Set(ids)];
    if (!unique.length || !this.deps.driver) return out;
    const rows = await this.db
      .select({ id: files.id, projectId: files.projectId, mime: files.mimeType, key: fileVersions.storageKey, size: fileVersions.sizeBytes })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(inArray(files.id, unique), isNull(files.deletedAt)));
    for (const id of unique) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.projectId !== projectId || !["image/png", "image/jpeg"].includes(r.mime) || Number(r.size) > MAX_FIGURE_BYTES) {
        out.set(id, null);
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const c of await this.deps.driver.get(r.key)) chunks.push(Buffer.from(c as Buffer));
      const data = Buffer.concat(chunks);
      const dim = imageSize(data);
      out.set(id, dim ? { data, ...dim } : null);
    }
    return out;
  }

  /** Worker entry point: builds the DOCX, renders and inspects the PDF, validates, stores. */
  async processExport(exportId: string) {
    const [x] = await this.db.select().from(documentExports).where(eq(documentExports.id, exportId));
    if (!x || x.status === "succeeded" || x.status === "failed") return;
    if (!this.deps.driver) throw new Error("Storage driver required for exports");
    await this.db.update(documentExports).set({ status: "running" }).where(eq(documentExports.id, exportId));
    try {
      const doc = await this.loadDoc(x.documentId);
      const [v] = await this.db.select().from(documentVersions).where(eq(documentVersions.id, x.versionId));
      const [specRow] = await this.db.select().from(documentSpecificationVersions).where(and(eq(documentSpecificationVersions.documentId, doc.id), eq(documentSpecificationVersions.version, v!.specVersion)));
      const spec = specRow!.spec as unknown as DocumentSpec;
      const refs = await this.refInputs(doc.projectId);
      const sections: SectionInput[] = v!.snapshot.sections.map((s, i) => ({ id: String(i), key: s.key, title: s.title, kind: s.kind as SectionInput["kind"], content: s.content, required: (s as { required?: boolean }).required ?? false, wordLimit: (s as { wordLimit?: number | null }).wordLimit ?? null }));
      const model = assemble(spec, sections, refs, "html");
      const figures = await this.loadFigures(doc.projectId, model.figureIds);
      const missingFigures = model.figureIds.filter((id) => !figures.get(id));
      const docx = await buildDocx({ title: v!.snapshot.title, meta: v!.snapshot.meta, spec, model, figures });
      let body = docx;
      let pages;
      let tocUpdated: boolean | undefined;
      if (x.format === "pdf") {
        const r = await docxToPdf(docx);
        body = r.pdf;
        tocUpdated = r.tocUpdated;
        pages = await inspectPdf(r.pdf);
      }
      const checks = validateDocument({ spec, model, refStatus: new Map(refs.map((r) => [r.key, r])), missingFigures, pages, tocUpdated });
      const key = `exports/${doc.projectId}/${doc.id}/${x.id}.${x.format}`;
      const put = await this.deps.driver.put(key, [body] as unknown as AsyncIterable<Uint8Array>, { maxBytes: MAX_EXPORT_BYTES });
      await this.db.transaction(async (tx) => {
        await tx.update(documentExports).set({ status: "succeeded", storageKey: key, sizeBytes: put.sizeBytes, pageCount: pages?.length ?? null, finishedAt: new Date(), error: null }).where(eq(documentExports.id, exportId));
        await tx.insert(documentValidationResults).values({ exportId, documentId: doc.id, passed: !checks.some((c) => c.status === "fail"), checks });
      });
      await this.prune(doc.id);
      const failed = checks.filter((c) => c.status === "fail").length;
      await notify(this.db, { userIds: [x.requestedByUserId], kind: "document.export_ready", title: `${x.format.toUpperCase()} ready: “${doc.title}”`, body: failed ? `The export finished, but ${failed} check${failed === 1 ? "" : "s"} failed. Review them before submitting.` : "The export finished and passed its checks.", link: `/app/projects/${doc.projectId}/documents/${doc.id}/versions`, projectId: doc.projectId, dedupeKey: `export:${exportId}` });
    } catch (err) {
      logger.warn("document.export_failed", { exportId, error: String(err) });
      await this.db.update(documentExports).set({ status: "failed", error: String((err as Error).message ?? err).slice(0, 500), finishedAt: new Date() }).where(eq(documentExports.id, exportId));
      const [d] = await this.db.select({ title: documents.title, projectId: documents.projectId }).from(documents).where(eq(documents.id, x.documentId));
      if (d) await notify(this.db, { userIds: [x.requestedByUserId], kind: "document.export_ready", title: `Export failed: “${d.title}”`, body: "The export could not be produced. Try again; if it keeps failing, check images and tables in the document.", link: `/app/projects/${d.projectId}/documents/${x.documentId}/versions`, projectId: d.projectId, dedupeKey: `export:${exportId}` });
    }
  }

  private async prune(documentId: string) {
    const keep = this.deps.keepExports ?? 10;
    const old = await this.db.select({ id: documentExports.id, key: documentExports.storageKey }).from(documentExports).where(and(eq(documentExports.documentId, documentId), inArray(documentExports.status, ["succeeded", "failed"]))).orderBy(desc(documentExports.createdAt)).offset(keep);
    for (const o of old) {
      if (o.key) await this.deps.driver?.delete(o.key).catch(() => {});
      await this.db.delete(documentExports).where(eq(documentExports.id, o.id));
    }
  }

  async openExport(actorUserId: string, exportId: string) {
    const [x] = await this.db.select().from(documentExports).where(eq(documentExports.id, exportId));
    if (!x || x.status !== "succeeded" || !x.storageKey) throw new AppError("NOT_FOUND", "Export not found.");
    const { doc } = await this.docFor(actorUserId, x.documentId, "read");
    if (!this.deps.driver) throw new Error("Storage driver required");
    const name = `${doc.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 80) || "document"}.${x.format}`;
    return { stream: await this.deps.driver.get(x.storageKey), filename: name, contentType: x.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: x.sizeBytes };
  }
}

function assembleWords(content: string): number {
  const p = parseMarkup(content);
  let n = 0;
  for (const b of p.blocks) {
    const texts = b.t === "p" || b.t === "h" || b.t === "quote" ? [b.inl] : b.t === "list" ? b.items : [];
    for (const inl of texts) n += inl.map((x) => (x.t === "text" ? x.v : "")).join("").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  return n;
}
