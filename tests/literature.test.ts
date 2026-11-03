import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBibliography, formatDocument, normalizeDoi, parseBibtex, parseName, parseRis, toBibtex, toRis } from "@researchmate/citations";
import { evidenceRecords, filePassages, files as filesTable } from "@researchmate/database";
import { extractText, fromCrossref, fromEuropePmc, fromOpenAlex, fromPubmed, fromSemanticScholar, hasOcr, invertedIndexToText, LiteratureService, makeCitationKey, parseArxiv, ScholarlyClient } from "@researchmate/literature";
import { ProjectService, ResearchContentService } from "@researchmate/research";
import { FileService, LocalStorageDriver } from "@researchmate/storage";
import { eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";

afterAll(closeTestDb);
const NOW = "2026-11-02T00:00:00.000Z";

async function pdfWithText(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  lines.forEach((l, i) => {
    if (i) doc.addPage();
    doc.fontSize(28).text(l, 72, 120);
  });
  doc.end();
  return done;
}

describe("citations", () => {
  const items = [
    { id: "suri2016", type: "article-journal", title: "The long-run poverty and gender impacts of mobile money", author: [{ family: "Suri", given: "Tavneet" }, { family: "Jack", given: "William" }], issued: { "date-parts": [[2016]] }, "container-title": "Science", volume: "354", issue: "6317", page: "1288-1292", DOI: "10.1126/science.aah5309" },
    { id: "smith2020a", type: "book", title: "Field methods", author: [{ family: "Smith", given: "Ann" }], issued: { "date-parts": [[2020]] }, publisher: "Sage" },
    { id: "smith2020b", type: "book", title: "Survey design", author: [{ family: "Smith", given: "Ann" }], issued: { "date-parts": [[2020]] }, publisher: "Sage" },
  ];

  it("formats in-text citations and bibliographies in every supported style", () => {
    const clusters = [{ id: "c1", items: [{ id: "suri2016", locator: "1290" }] }, { id: "c2", items: [{ id: "smith2020a" }, { id: "smith2020b" }] }];
    const apa = formatDocument("apa7", items, clusters);
    expect(apa.citations.get("c1")).toBe("(Suri & Jack, 2016, p. 1290)");
    expect(apa.citations.get("c2")).toBe("(Smith, 2020a, 2020b)"); // disambiguated
    expect(apa.bibliography[2]).toMatch(/^Suri, T\., & Jack, W\. \(2016\)\. The long-run poverty/);
    const ieee = formatDocument("ieee", items, clusters);
    expect(ieee.citations.get("c1")).toBe("[1, p. 1290]");
    expect(ieee.citations.get("c2")).toMatch(/^\[2\], \[3\]$|^\[2, 3\]$|^\[2\]–\[3\]$/);
    expect(formatDocument("vancouver", items, clusters).bibliography[0]).toMatch(/^1\. Suri T, Jack W\./);
    for (const s of ["harvard", "mla", "chicago"] as const) expect(formatBibliography(s, items)).toHaveLength(3);
    expect(formatDocument("apa7", items, [{ id: "x", items: [{ id: "missing" }] }]).missing).toEqual(["missing"]);
  });

  it("parses and writes BibTeX and RIS, normalising DOIs and names", () => {
    const bib = parseBibtex(`@string{sci = "Science"}
@article{suri2016, title = {The long-run {P}overty and Gender Impacts of Mobile Money}, author = {Suri, Tavneet and William Jack}, journal = sci, year = 2016, volume = {354}, pages = {1288--1292}, doi = {https://doi.org/10.1126/SCIENCE.aah5309}}
@book{vanderberg2019, title = "Research {\\&} practice", author = {Ludwig van der Berg}, publisher = {Pearson}, year = {2019}}
@misc{broken, author = {No Title}}`);
    expect(bib.items).toHaveLength(2);
    expect(bib.errors).toEqual(['Entry "broken" has no title.']);
    expect(bib.items[0]).toMatchObject({ id: "suri2016", type: "article-journal", "container-title": "Science", page: "1288–1292", DOI: "10.1126/science.aah5309", author: [{ family: "Suri", given: "Tavneet" }, { family: "Jack", given: "William" }] });
    expect(bib.items[1]!.author).toEqual([{ given: "Ludwig", family: "van der Berg" }]);
    expect(bib.items[1]!.title).toBe("Research & practice");
    const again = parseBibtex(toBibtex(bib.items)).items;
    expect(again.map((i) => [i.id, i.title, i.DOI])).toEqual(bib.items.map((i) => [i.id, i.title, i.DOI]));

    const ris = parseRis("TY  - JOUR\nTI  - Mobile money\nAU  - Jack, William\nAU  - Suri, Tavneet\nPY  - 2014\nJO  - American Economic Review\nSP  - 183\nEP  - 223\nDO  - 10.1257/aer.104.1.183\nER  - \nTY  - BOOK\nAU  - Nobody\nER  - \n");
    expect(ris.items[0]).toMatchObject({ title: "Mobile money", page: "183–223", DOI: "10.1257/aer.104.1.183" });
    expect(ris.errors).toHaveLength(1);
    expect(parseRis(toRis(ris.items)).items[0]!.author).toEqual(ris.items[0]!.author);
    expect(normalizeDoi("doi:10.1000/XYZ.123.")).toBe("10.1000/xyz.123");
    expect(normalizeDoi("not a doi")).toBeNull();
    expect(parseName("Maria de la Cruz")).toEqual({ given: "Maria", family: "de la Cruz" });
  });
});

describe("scholarly providers (documented response formats)", () => {
  it("normalises Crossref, OpenAlex, Semantic Scholar, PubMed, Europe PMC and arXiv", () => {
    expect(fromCrossref({ DOI: "10.1126/science.aah5309", title: ["The long-run poverty and gender impacts of mobile money"], author: [{ given: "Tavneet", family: "Suri" }], issued: { "date-parts": [[2016, 12, 9]] }, "container-title": ["Science"], volume: "354", type: "journal-article", abstract: "<jats:p>We estimate…</jats:p>" }, NOW)).toMatchObject({ doi: "10.1126/science.aah5309", year: 2016, venue: "Science", access: "abstract", abstract: "We estimate…", authors: [{ family: "Suri", given: "Tavneet" }] });
    expect(invertedIndexToText({ mobile: [0], money: [1], works: [2] })).toBe("mobile money works");
    expect(fromOpenAlex({ id: "https://openalex.org/W1", doi: "https://doi.org/10.1234/abc", title: "Paper", publication_year: 2021, authorships: [{ author: { display_name: "Jane Doe" } }], primary_location: { source: { display_name: "Journal" } }, biblio: { volume: "3", first_page: "10", last_page: "20" }, abstract_inverted_index: null, open_access: { oa_url: "https://oa/x.pdf" } }, NOW)).toMatchObject({ externalId: "W1", doi: "10.1234/abc", pages: "10–20", access: "metadata", openAccessUrl: "https://oa/x.pdf", authors: [{ given: "Jane", family: "Doe" }] });
    expect(fromSemanticScholar({ paperId: "abc", title: "S2 paper", year: 2019, authors: [{ name: "Ana Lima" }], externalIds: { DOI: "10.5555/S2" }, abstract: "Text", openAccessPdf: null }, NOW)).toMatchObject({ doi: "10.5555/s2", access: "abstract" });
    expect(fromPubmed({ uid: "123", title: "Malaria nets.", authors: [{ name: "Okello JP", authtype: "Author" }], pubdate: "2018 Mar", fulljournalname: "Lancet", articleids: [{ idtype: "doi", value: "10.1016/lan" }] }, NOW)).toMatchObject({ title: "Malaria nets", year: 2018, access: "metadata", authors: [{ family: "Okello", given: "J. P." }] });
    expect(fromEuropePmc({ id: "999", source: "MED", pmid: "999", title: "EPMC.", authorString: "Mwangi K, Otieno P.", pubYear: "2020", journalTitle: "BMJ", abstractText: "Background…" }, NOW)).toMatchObject({ externalId: "MED:999", year: 2020, access: "abstract", authors: [{ family: "Mwangi", given: "K." }, { family: "Otieno", given: "P." }] });
    const arxiv = parseArxiv(`<feed><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2101.00001v1</id><published>2021-01-01T00:00:00Z</published><title>Deep  learning &amp; crops</title><summary>We show…</summary><author><name>Ada Wanjiku</name></author><link title="pdf" href="http://arxiv.org/pdf/2101.00001v1"/></entry></feed>`, NOW);
    expect(arxiv[0]).toMatchObject({ externalId: "2101.00001v1", title: "Deep learning & crops", year: 2021, openAccessUrl: "http://arxiv.org/pdf/2101.00001v1", access: "abstract" });
  });

  it("paginates, sends the contact email, and reports rate limits", async () => {
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      if (url.includes("ratelimit")) return new Response("", { status: 429 });
      return new Response(JSON.stringify({ message: { "total-results": 45, items: [{ DOI: "10.1234/a", title: ["A"] }] } }), { status: 200 });
    };
    const c = new ScholarlyClient({ fetch: fake as never, contactEmail: "ops@example.org" });
    const p = await c.search("crossref", "mobile money", { cursor: "20", pageSize: 20 });
    expect(urls[0]).toContain("offset=20");
    expect(urls[0]).toContain("mailto=ops%40example.org");
    expect(p.nextCursor).toBe("40");
    await expect(c.search("crossref", "ratelimit")).rejects.toThrow(/rate limit/);
  });
});

async function setup(plan = "research_pro") {
  const u = await createUser();
  await setPlan(u.orgId, plan);
  const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Lit project", researchType: "custom", workflowTemplateKey: "" });
  return { u, project };
}

const registry = (records: Record<string, unknown>) =>
  new ScholarlyClient({
    fetch: (async (url: string) => {
      const doi = decodeURIComponent(url.split("/works/")[1]?.split("?")[0] ?? "");
      return records[doi] ? new Response(JSON.stringify({ message: records[doi] }), { status: 200 }) : new Response("", { status: 404 });
    }) as never,
  });

describe("reference library and verification", () => {
  it("is not available on Free; imports with keys and duplicate detection", async () => {
    const free = await setup("free");
    const lit = new LiteratureService(testDb(), { scholarly: new ScholarlyClient() });
    await expect(lit.addManual(free.u.userId, free.project.id, { title: "X paper" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });

    const { u, project } = await setup();
    const r = await lit.importText(u.userId, project.id, "bibtex", `@article{suri2016, title={Mobile money}, author={Suri, T.}, year={2016}, doi={10.1234/MM}}\n@article{dup, title={Mobile Money}, author={Suri, T.}, year={2016}}\n@article{other, title={Other}, author={Jack, W.}, year={2014}}`);
    expect(r).toMatchObject({ added: 2, duplicates: 1 });
    const refs = await lit.list(u.userId, project.id);
    expect(refs.map((x) => x.citationKey).sort()).toEqual(["other", "suri2016"]);
    expect(refs.every((x) => x.verificationStatus === "unverified")).toBe(true);
    const manual = await lit.addManual(u.userId, project.id, { title: "A third study", authors: "Suri, Tavneet", year: 2016 });
    expect(manual.citationKey).toBe("suri2016a");
    await expect(lit.addManual(u.userId, project.id, { title: "a third STUDY", year: 2016 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await lit.list(u.userId, project.id, "third")).map((x) => x.id)).toEqual([manual.id]);
    expect(await lit.exportText(u.userId, project.id, "bibtex")).toContain("@article{suri2016,");
    expect(makeCitationKey({ id: "", type: "book", title: "No author" }, new Set())).toBe("nond");
  });

  it("verifies against the DOI registry and never claims more than was done", async () => {
    const { u, project } = await setup();
    const lit = new LiteratureService(testDb(), { scholarly: registry({ "10.1234/good": { DOI: "10.1234/good", title: ["Mobile money and savings"], author: [{ family: "Jack", given: "W." }], issued: { "date-parts": [[2014]] } }, "10.1234/bad": { DOI: "10.1234/bad", title: ["Something else entirely"], issued: { "date-parts": [[1999]] } } }) });
    await lit.importText(u.userId, project.id, "ris", "TY  - JOUR\nTI  - Mobile money and savings\nAU  - Jack, W.\nPY  - 2014\nDO  - 10.1234/good\nER  - \nTY  - JOUR\nTI  - Fabricated paper\nPY  - 2020\nDO  - 10.1234/bad\nER  - \nTY  - JOUR\nTI  - Unknown DOI\nPY  - 2020\nDO  - 10.1234/none\nER  - \n");
    const refs = Object.fromEntries((await lit.list(u.userId, project.id)).map((r) => [r.doi, r]));
    expect((await lit.verify(u.userId, refs["10.1234/good"]!.id)).status).toBe("metadata_verified");
    const bad = await lit.verify(u.userId, refs["10.1234/bad"]!.id);
    expect(bad.status).toBe("verification_failed");
    expect(bad.issues.join(" ")).toMatch(/Title differs.*Year differs/);
    expect((await lit.verify(u.userId, refs["10.1234/none"]!.id)).issues).toEqual(["The DOI was not found in the registry."]);

    // Full text: "retrieved" when attached; "reviewed" only by a person, and only with the file.
    await expect(lit.markReviewed(u.userId, refs["10.1234/good"]!.id)).rejects.toThrow(/Attach the full text/);
    const dir = mkdtempSync(join(tmpdir(), "rm-lit-"));
    const svc = new FileService({ db: testDb(), driver: new LocalStorageDriver(dir), maxUploadBytes: 50e6 });
    const pdf = await pdfWithText(["Full text of the paper"]);
    const f = await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: project.id, filename: "jack2014.pdf", declaredSize: pdf.length, body: [pdf] as never });
    await lit.attachFullText(u.userId, refs["10.1234/good"]!.id, f.id);
    await lit.markReviewed(u.userId, refs["10.1234/good"]!.id);
    const { reference, events } = await lit.get(u.userId, refs["10.1234/good"]!.id);
    expect(reference).toMatchObject({ verificationStatus: "full_text_reviewed", accessLevel: "full_text" });
    expect(events.map((e) => e.toStatus)).toEqual(["full_text_reviewed", "full_text_retrieved", "metadata_verified", "unverified"]);
  });

  it("keeps evidence traceable and matrix entries honest about their basis", async () => {
    const { u, project } = await setup();
    const lit = new LiteratureService(testDb(), { scholarly: new ScholarlyClient() });
    const ref = await lit.addManual(u.userId, project.id, { title: "Metadata only study", year: 2010 });
    await expect(lit.saveMatrixEntry(u.userId, ref.id, { findings: "x", basis: "full_text" })).rejects.toThrow(/can't be based on more/);
    await lit.saveMatrixEntry(u.userId, ref.id, { findings: "From the abstract we can't say", basis: "metadata" });
    const theme = await lit.addTheme(u.userId, project.id, "Financial inclusion");
    const q = await new ResearchContentService(testDb()).addQuestion(u.userId, project.id, { text: "How does mobile money affect savings?" });
    await expect(lit.addEvidence(u.userId, project.id, { passage: "Savings rose 22%" })).rejects.toThrow(/traced/);
    const e = await lit.addEvidence(u.userId, project.id, { passage: "Savings rose 22%", claim: "Mobile money increases savings", referenceId: ref.id, page: 7, themeId: theme.id, researchQuestionId: q.id });
    expect(e).toMatchObject({ reviewStatus: "accepted", extractionMethod: "manual" });
    const list = await lit.listEvidence(u.userId, project.id);
    expect(list[0]).toMatchObject({ citationKey: ref.citationKey, theme: "Financial inclusion" });
    const other = await setup();
    const foreign = await lit.addTheme(other.u.userId, other.project.id, "Theirs");
    await expect(lit.addEvidence(u.userId, project.id, { passage: "x y z", referenceId: ref.id, themeId: foreign.id })).rejects.toThrow(/another project/);
    await expect(lit.listEvidence(other.u.userId, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await lit.matrix(u.userId, project.id))[0]!.entry).toMatchObject({ basis: "metadata" });
    void evidenceRecords;
  });
});

describe("text extraction", () => {
  it("extracts PDF text per page and indexes it for search with page numbers", async () => {
    const { u, project } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "rm-ext-"));
    const driver = new LocalStorageDriver(dir);
    let lit!: LiteratureService;
    const svc = new FileService({ db: testDb(), driver, maxUploadBytes: 50e6, afterStore: (f) => lit.queueExtraction(f.id, f.version, f.mimeType, f.aiProcessingAllowed) });
    const queued: string[] = [];
    lit = new LiteratureService(testDb(), { scholarly: new ScholarlyClient(), driver, enqueueExtraction: async (id) => void queued.push(id) });
    const pdf = await pdfWithText(["Introduction to irrigation", "Smallholder maize yields increased"]);
    const f = await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, projectId: project.id, filename: "study.pdf", declaredSize: pdf.length, body: [pdf] as never });
    expect(queued).toHaveLength(1);
    await lit.processExtraction(queued[0]!);
    expect((await testDb().select().from(filesTable).where(eq(filesTable.id, f.id)))[0]!.processingStatus).toBe("processed");
    const hits = await lit.searchPassages(u.userId, project.id, "maize yields");
    expect(hits[0]).toMatchObject({ fileName: "study.pdf", page: 2, method: "text" });
    expect(hits[0]!.snippet).toMatch(/«maize» «yields»/);

    // Free plan: stored, never processed.
    const free = await setup("free");
    const q2: string[] = [];
    const lit2 = new LiteratureService(testDb(), { scholarly: new ScholarlyClient(), driver, enqueueExtraction: async (id) => void q2.push(id) });
    const svc2 = new FileService({ db: testDb(), driver, maxUploadBytes: 50e6, afterStore: (x) => lit2.queueExtraction(x.id, x.version, x.mimeType, x.aiProcessingAllowed) });
    await svc2.upload({ actorUserId: free.u.userId, organizationId: free.u.orgId, filename: "free.pdf", declaredSize: pdf.length, body: [pdf] as never });
    expect(q2).toHaveLength(0);
  });

  it("falls back to OCR for scanned PDFs when Tesseract is available", async (ctx) => {
    if (!(await hasOcr())) ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "rm-ocr-"));
    writeFileSync(join(dir, "text.pdf"), await pdfWithText(["Groundwater recharge"]));
    execFileSync("pdftoppm", ["-r", "150", "-png", "-singlefile", join(dir, "text.pdf"), join(dir, "scan")]);
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
    doc.image(readFileSync(join(dir, "scan.png")), 0, 0, { width: 595 });
    doc.end();
    const scanned = await done;
    expect((await extractText(scanned, "application/pdf"))[0]!.text).toBe(""); // no text layer
    const ocr = await extractText(scanned, "application/pdf", { ocr: true });
    expect(ocr[0]).toMatchObject({ method: "ocr", page: 1 });
    expect(ocr[0]!.text).toMatch(/Groundwater recharge/i);
    void filePassages;
  }, 60_000);
});
