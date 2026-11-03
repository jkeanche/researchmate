import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { documentSpecificationVersions, documentVersions, DOCUMENT_TEMPLATE_SEEDS } from "@researchmate/database";
import { assemble, DocumentService, hasLibreOffice, parseMarkup, texToText, validateDocument } from "@researchmate/documents";
import { LiteratureService, ScholarlyClient } from "@researchmate/literature";
import { ProjectMemberService, ProjectService } from "@researchmate/research";
import { FileService, LocalStorageDriver } from "@researchmate/storage";
import { addMemberByEmail } from "@researchmate/tenancy";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";

afterAll(closeTestDb);

const appendOnly = (e: unknown) => /append-only/.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message));

/** A solid-colour PNG of the given size (valid zlib stream, CRCs computed). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function setup(plan = "research_pro") {
  const u = await createUser("Writer");
  await setPlan(u.orgId, plan);
  const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Mobile money thesis", researchType: "masters_thesis", workflowTemplateKey: "" });
  const driver = new LocalStorageDriver(mkdtempSync(join(tmpdir(), "rm-doc-")));
  const queued: string[] = [];
  const docs = new DocumentService(testDb(), { driver, enqueueExport: async (id) => void queued.push(id) });
  const lit = new LiteratureService(testDb(), { scholarly: new ScholarlyClient() });
  const files = new FileService({ db: testDb(), driver, maxUploadBytes: 10e6 });
  return { u, project, docs, lit, files, queued, driver };
}

const sectionByKey = async (docs: DocumentService, userId: string, docId: string, key: string) => (await docs.get(userId, docId)).sections.find((s) => s.key === key)!;

describe("markup", () => {
  it("parses headings, lists, tables, figures, equations and citation clusters", () => {
    const p = parseMarkup(
      [
        "Mobile money spread [@suri2016]. See [see @jack2014, pp. 3-4; -@suri2016] and *italic* **bold** `code`.",
        "## Background",
        "- a",
        "- b",
        "Table: Results",
        "| A | B |",
        "|---|---|",
        "| 1 | [@x1, ch. 2] |",
        "![Map of sites](file:11111111-2222-3333-4444-555555555555)",
        "![Bad](https://example.com/x.png)",
        "$$ \\beta_1 x^2 $$",
        "Email me@example.org is not a citation, nor is [this @ thing].",
      ].join("\n"),
    );
    expect(p.blocks.map((b) => b.t)).toEqual(["p", "h", "list", "table", "figure", "eq", "p"]);
    expect(p.clusters).toEqual([
      [{ key: "suri2016" }],
      [
        { key: "jack2014", prefix: "see", label: "page", locator: "3–4" },
        { key: "suri2016", suppressAuthor: true },
      ],
      [{ key: "x1", label: "chapter", locator: "2" }],
    ]);
    expect(p.problems[0]).toMatch(/must refer to a project file/);
    expect(texToText("\\beta_1 x^2 + \\frac{a}{b} \\leq \\infty")).toBe("β₁ x² + (a)/(b) ≤ ∞");
  });

  it("numbers headings, tables and figures, and counts only running text", () => {
    const spec = DOCUMENT_TEMPLATE_SEEDS.find((t) => t.key === "masters_dissertation")!.spec;
    const sections = spec.sections.map((s, i) => ({ id: String(i), key: s.key, title: s.title, kind: s.kind, required: s.required, wordLimit: s.wordLimit ?? null, content: s.key === "introduction" ? "One two three [@a].\n\n## Sub\n\nfour five\n\nTable: T\n| x y z |\n|---|" : s.key === "methodology" ? "Six seven." : "" }));
    const m = assemble(spec, sections, [{ id: "1", key: "a", csl: { type: "book", title: "A book", author: [{ family: "Ade", given: "B" }], issued: { "date-parts": [[2020]] } }, verificationStatus: "metadata_verified", accessLevel: "metadata" }]);
    expect(m.headings.map((h) => h.text)).toEqual(["1 Introduction", "1.1 Sub", "2 Literature Review", "3 Methodology", "4 Results", "5 Discussion", "6 Conclusion and Recommendations", "References"]);
    expect(m.words.body).toBe(8); // "One two three" + "Sub" + "four five" + "Six seven"; citations and tables excluded
    expect([...m.citationText.values()]).toEqual(["(Ade, 2020)"]);
    const checks = validateDocument({ spec, model: m, refStatus: new Map(), missingFigures: [] });
    expect(checks.find((c) => c.key === "required_sections")).toMatchObject({ status: "fail" });
    expect(checks.find((c) => c.key === "word_limit")).toMatchObject({ status: "warn" });
  });

  it("detects content past the margins in rendered pages", () => {
    const spec = DOCUMENT_TEMPLATE_SEEDS.find((t) => t.key === "custom")!.spec;
    const m = assemble(spec, [], []);
    const page = (items: { str: string; x: number; y: number; w: number; h: number }[]) => ({ width: 595.3, height: 841.9, items, images: [], text: items.map((i) => i.str).join("\n") });
    const ok = validateDocument({ spec, model: m, refStatus: new Map(), missingFigures: [], pages: [page([{ str: "Body", x: 90, y: 700, w: 300, h: 12 }, { str: "1", x: 295, y: 30, w: 6, h: 12 }])] });
    expect(ok.find((c) => c.key === "overflow")!.status).toBe("pass");
    const bad = validateDocument({ spec, model: m, refStatus: new Map(), missingFigures: [], pages: [page([{ str: "A very wide table cell", x: 90, y: 700, w: 520, h: 12 }])] });
    expect(bad.find((c) => c.key === "overflow")).toMatchObject({ status: "fail", detail: expect.stringContaining("page 1") });
    expect(bad.find((c) => c.key === "page_numbers")!.status).toBe("fail");
  });
});

describe("documents", () => {
  it("creates from a template with versioned specification; specification history is append-only", async () => {
    const { u, project, docs } = await setup();
    const doc = await docs.create(u.userId, project.id, { templateKey: "masters_dissertation", title: "Mobile money and savings", meta: { author: "A. Otieno", degree: "MSc Economics", bogus: "x" } });
    const view = await docs.get(u.userId, doc.id);
    expect(view.sections.map((s) => s.key)).toEqual(["title", "declaration", "abstract", "acknowledgements", "toc", "introduction", "literature_review", "methodology", "results", "discussion", "conclusion", "references", "appendices"]);
    expect(view.document.meta).toEqual({ author: "A. Otieno", degree: "MSc Economics" });
    expect(view.spec.citationStyle).toBe("apa7");

    await expect(docs.updateSpec(u.userId, doc.id, { lineSpacing: 7 })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await docs.updateSpec(u.userId, doc.id, { citationStyle: "ieee", lineSpacing: 2 }, "Department rules")).toBe(2);
    expect((await docs.get(u.userId, doc.id)).spec).toMatchObject({ citationStyle: "ieee", lineSpacing: 2 });
    expect((await docs.specHistory(u.userId, doc.id)).map((h) => h.version)).toEqual([2, 1]);
    await expect(testDb().update(documentSpecificationVersions).set({ note: "x" }).where(eq(documentSpecificationVersions.documentId, doc.id))).rejects.toSatisfy(appendOnly);
  });

  it("saves sections with optimistic concurrency, indexes citations, and keeps versions", async () => {
    const { u, project, docs, lit } = await setup();
    await lit.importText(u.userId, project.id, "bibtex", "@article{suri2016, title={The long-run impacts of mobile money}, author={Suri, Tavneet and Jack, William}, journal={Science}, year={2016}}");
    const doc = await docs.create(u.userId, project.id, { templateKey: "masters_dissertation", title: "Thesis" });
    const intro = await sectionByKey(docs, u.userId, doc.id, "introduction");
    const saved = await docs.saveSection(u.userId, intro.id, { content: "Mobile money matters [@suri2016, p. 2]. Unknown [@ghost2020].", version: intro.version });
    expect(saved.version).toBe(intro.version + 1);
    await expect(docs.saveSection(u.userId, intro.id, { content: "stale", version: intro.version })).rejects.toMatchObject({ code: "CONFLICT" });
    const toc = await sectionByKey(docs, u.userId, doc.id, "toc");
    await expect(docs.saveSection(u.userId, toc.id, { content: "x", version: toc.version })).rejects.toThrow(/generated automatically/);

    const audit = await docs.audit(u.userId, doc.id);
    expect(audit.citations.map((c) => [c.key, !!c.referenceId, c.locators])).toEqual([
      ["suri2016", true, ["2"]],
      ["ghost2020", false, []],
    ]);
    expect(audit.unverified.map((c) => c.key)).toEqual(["suri2016"]);
    expect(audit.metadataOnly.map((c) => c.key)).toEqual(["suri2016"]);

    // The library reference can't be deleted while cited.
    const [ref] = await lit.list(u.userId, project.id);
    await expect(lit.remove(u.userId, ref!.id)).rejects.toThrow(/cited in a document/);

    const v1 = await docs.saveVersion(u.userId, doc.id, "First draft");
    await docs.saveSection(u.userId, intro.id, { content: "Rewritten.", version: saved.version });
    await docs.restoreVersion(u.userId, v1.id);
    expect((await sectionByKey(docs, u.userId, doc.id, "introduction")).content).toMatch(/^Mobile money matters/);
    expect((await docs.versions(u.userId, doc.id)).map((v) => v.label)).toEqual(["Before restoring version 1", "First draft"]);
    await expect(testDb().delete(documentVersions).where(eq(documentVersions.documentId, doc.id))).rejects.toSatisfy(appendOnly);

    // Sections: add, move among the same kind, remove only empty optional ones.
    const extra = await docs.addSection(u.userId, doc.id, { title: "Policy Implications", kind: "body" });
    expect(extra.key).toBe("policy_implications");
    await docs.moveSection(u.userId, extra.id, "up");
    const order = (await docs.get(u.userId, doc.id)).sections.map((s) => s.key);
    expect(order.indexOf("policy_implications")).toBe(order.indexOf("conclusion") - 1);
    await expect(docs.removeSection(u.userId, intro.id)).rejects.toThrow(/required/);
    await docs.removeSection(u.userId, extra.id);

    // Deleting the document removes its (otherwise immutable) history.
    await docs.remove(u.userId, doc.id);
    expect(await testDb().select().from(documentVersions).where(eq(documentVersions.documentId, doc.id))).toHaveLength(0);
  });

  it("unknown citations and the Free plan block export; supervisors comment, finance roles see nothing", async () => {
    const free = await setup("free");
    const fdoc = await free.docs.create(free.u.userId, free.project.id, { templateKey: "custom", title: "Notes" });
    await expect(free.docs.requestExport(free.u.userId, fdoc.id, "docx")).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });

    const { u, project, docs, queued } = await setup();
    const doc = await docs.create(u.userId, project.id, { templateKey: "custom", title: "Draft" });
    const main = await sectionByKey(docs, u.userId, doc.id, "main");
    await docs.saveSection(u.userId, main.id, { content: "As shown [@nobody2021].", version: main.version });
    await expect(docs.requestExport(u.userId, doc.id, "pdf")).rejects.toThrow(/don't match any source.*@nobody2021/);
    expect(queued).toHaveLength(0);

    const sup = await createUser("Supervisor");
    const fin = await createUser("Finance");
    await addMemberByEmail(testDb(), u.userId, u.orgId, sup.email, "org_member");
    await addMemberByEmail(testDb(), u.userId, u.orgId, fin.email, "org_member");
    const members = new ProjectMemberService(testDb());
    await members.add(u.userId, project.id, sup.userId, "project_supervisor");
    await members.add(u.userId, project.id, fin.userId, "project_finance_manager");
    const c = await docs.addComment(sup.userId, doc.id, { sectionId: main.id, quote: "As shown", body: "Which study?" });
    await docs.addComment(u.userId, doc.id, { parentId: c.id, body: "Adding it now." });
    await expect(docs.saveSection(sup.userId, main.id, { content: "x", version: 99 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await docs.resolveComment(u.userId, c.id);
    const thread = await docs.comments(sup.userId, doc.id);
    expect(thread.map((t) => [t.c.body, t.c.sectionId === main.id, !!t.c.resolvedAt])).toEqual([
      ["Which study?", true, true],
      ["Adding it now.", true, false],
    ]);
    await expect(docs.get(fin.userId, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stranger = await createUser("Stranger");
    await expect(docs.get(stranger.userId, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("links evidence to sections and flags evidence whose source isn't cited there", async () => {
    const { u, project, docs, lit } = await setup();
    await lit.importText(u.userId, project.id, "bibtex", "@article{jack2014, title={Risk sharing}, author={Jack, William}, journal={AER}, year={2014}}");
    const [ref] = await lit.list(u.userId, project.id);
    const ev = await lit.addEvidence(u.userId, project.id, { passage: "Households smoothed consumption.", claim: "Risk sharing improved", referenceId: ref!.id });
    const doc = await docs.create(u.userId, project.id, { templateKey: "custom", title: "Draft" });
    const main = await sectionByKey(docs, u.userId, doc.id, "main");
    await docs.linkEvidence(u.userId, main.id, ev.id);
    expect((await docs.audit(u.userId, doc.id)).uncitedEvidence).toHaveLength(1);
    await docs.saveSection(u.userId, main.id, { content: "Risk sharing improved [@jack2014].", version: main.version });
    expect((await docs.audit(u.userId, doc.id)).uncitedEvidence).toHaveLength(0);
    expect((await docs.sectionEvidence(u.userId, doc.id))[0]).toMatchObject({ sectionId: main.id, key: "jack2014" });
  });
});

describe("export (LibreOffice)", async () => {
  const office = await hasLibreOffice();

  it.skipIf(!office)("renders DOCX and PDF from a snapshot and validates the real output", async () => {
    const { u, project, docs, lit, files, queued, driver } = await setup();
    await lit.importText(u.userId, project.id, "bibtex", "@article{suri2016, title={The long-run poverty and gender impacts of mobile money}, author={Suri, Tavneet and Jack, William}, journal={Science}, volume={354}, pages={1288--1292}, year={2016}}");
    const img = png(800, 400);
    const fig = await files.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: project.id, filename: "sites.png", declaredSize: img.length, body: [img] as never });
    const doc = await docs.create(u.userId, project.id, { templateKey: "masters_dissertation", title: "Mobile Money and Household Savings", meta: { author: "Amara Otieno", degree: "Master of Science in Economics", institution: "University of Nairobi" } });
    const fill: Record<string, string> = {
      declaration: "This is my own work.",
      abstract: "We study savings. ".repeat(20),
      introduction: "Mobile money spread quickly [@suri2016, p. 1290].\n\n## Context\n\nKenya led adoption.",
      literature_review: `Table: Studies\n| Study | Finding |\n|---|---|\n| Suri and Jack | Savings rose |\n\n![Study sites](file:${fig.id})`,
      methodology: "$$ y_i = \\alpha + \\beta x_i + \\varepsilon_i $$",
      results: "Results.",
      discussion: "Discussion.",
      conclusion: "Conclusion.",
    };
    for (const s of (await docs.get(u.userId, doc.id)).sections) if (fill[s.key]) await docs.saveSection(u.userId, s.id, { content: fill[s.key]!, version: s.version });

    const x1 = await docs.requestExport(u.userId, doc.id, "docx");
    const x2 = await docs.requestExport(u.userId, doc.id, "pdf");
    expect(queued).toEqual([x1.id, x2.id]);
    // Edits after the request don't change the export: it uses the snapshot.
    const intro = await sectionByKey(docs, u.userId, doc.id, "introduction");
    await docs.saveSection(u.userId, intro.id, { content: "CHANGED AFTER EXPORT", version: intro.version });
    for (const id of queued) await docs.processExport(id);

    const list = await docs.exports(u.userId, doc.id);
    const pdf = list.find((e) => e.x.format === "pdf")!;
    const docx = list.find((e) => e.x.format === "docx")!;
    expect(docx.x, String(docx.x.error)).toMatchObject({ status: "succeeded" });
    expect(pdf.x, String(pdf.x.error)).toMatchObject({ status: "succeeded" });
    expect(pdf.x.pageCount).toBeGreaterThanOrEqual(8);
    const byKey = Object.fromEntries(pdf.validation!.checks.map((c) => [c.key, c]));
    
    for (const k of ["required_sections", "citations_resolved", "page_size", "overflow", "headings", "toc", "tables", "figures_rendered", "page_numbers"]) expect(byKey[k], k).toMatchObject({ status: "pass" });
    expect(byKey.word_limit.status).toBe("warn"); // far below 15,000 words
    expect(byKey.citation_verification.status).toBe("warn"); // unverified source

    const opened = await docs.openExport(u.userId, pdf.x.id);
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(Buffer.from(c as Buffer));
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(opened.filename).toBe("Mobile Money and Household Savings.pdf");
    const { inspectPdf } = await import("@researchmate/documents");
    const text = (await inspectPdf(bytes)).map((p) => p.text).join("\n");
    expect(text).toContain("(Suri & Jack, 2016, p. 1290)");
    expect(text).toContain("y");
    expect(text).toContain("β");
    expect(text).not.toContain("CHANGED AFTER EXPORT");
    const docxBytes: Buffer[] = [];
    for await (const c of (await docs.openExport(u.userId, docx.x.id)).stream) docxBytes.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(docxBytes).subarray(0, 2).toString()).toBe("PK");
    expect(await driver.exists(pdf.x.storageKey!)).toBe(true);
  }, 120_000);

  it.skipIf(!office)("fails page-limit validation on an over-long conference paper", async () => {
    const { u, project, docs, queued } = await setup();
    const doc = await docs.create(u.userId, project.id, { templateKey: "conference_paper", title: "Too long" });
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"Mobile money changed how households save and share risk across distances. ".repeat(12)}`).join("\n\n");
    for (const s of (await docs.get(u.userId, doc.id)).sections) if (["abstract", "introduction", "method", "results", "conclusion"].includes(s.key)) await docs.saveSection(u.userId, s.id, { content: s.key === "abstract" ? "Short abstract." : long, version: s.version });
    await docs.requestExport(u.userId, doc.id, "pdf");
    await docs.processExport(queued[0]!);
    const [e] = await docs.exports(u.userId, doc.id);
    expect(e!.x, String(e!.x.error)).toMatchObject({ status: "succeeded" });
    expect(e!.validation!.passed).toBe(false);
    expect(e!.validation!.checks.find((c) => c.key === "page_count")).toMatchObject({ status: "fail", detail: expect.stringMatching(/of 8 allowed/) });
    expect(e!.validation!.checks.find((c) => c.key === "overflow")!.status).toBe("pass");
    await testDb().execute(sql`select 1`);
  }, 120_000);
});
