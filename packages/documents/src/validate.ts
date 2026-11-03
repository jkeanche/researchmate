import type { DocumentSpec, ValidationCheck } from "@researchmate/database";
import { type Assembled, isEmptyOptional } from "./model";
import type { PdfPage } from "./pdf";
import { PAGE_MM } from "./spec";

export interface ValidationInput {
  spec: DocumentSpec;
  model: Assembled;
  /** Verification status of every cited reference, by citation key. */
  refStatus: Map<string, { verificationStatus: string; accessLevel: string }>;
  /** Figure file ids that could not be loaded as PNG/JPEG. */
  missingFigures: string[];
  /** Present for PDF exports: the rendered pages. */
  pages?: PdfPage[];
  tocUpdated?: boolean;
}

const PT_PER_MM = 72 / 25.4;
const fmt = (n: number) => n.toLocaleString("en");
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[‐-―]/g, "-").trim().toLowerCase();

function roman(n: number): string {
  const r: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of r) while (n >= v) (out += s), (n -= v);
  return out;
}

/**
 * Checks the document against its specification. Content checks use the
 * assembled model; layout checks (PDF) use the rendered pages themselves, so
 * they report what a reader will actually see.
 */
export function validateDocument(v: ValidationInput): ValidationCheck[] {
  const { spec, model } = v;
  const checks: ValidationCheck[] = [];
  const add = (key: string, label: string, status: ValidationCheck["status"], detail: string) => checks.push({ key, label, status, detail });

  // --- Content -------------------------------------------------------------
  const emptyRequired = model.sections.filter((s) => s.section.required && ["front", "body"].includes(s.section.kind) && s.blocks.length === 0).map((s) => s.section.title);
  add("required_sections", "Required sections", emptyRequired.length ? "fail" : "pass", emptyRequired.length ? `Empty: ${emptyRequired.join(", ")}.` : "All required sections have content.");

  const { minWords, maxWords, abstractMaxWords } = spec.limits;
  const body = model.words.body;
  if (minWords || maxWords) {
    const over = maxWords != null && body > maxWords;
    const under = minWords != null && body < minWords;
    add("word_limit", "Word count (main text)", over ? "fail" : under ? "warn" : "pass", `${fmt(body)} words${minWords ? `; minimum ${fmt(minWords)}` : ""}${maxWords ? `; maximum ${fmt(maxWords)}` : ""}. Excludes preliminary pages, tables, captions, citations, references and appendices.`);
  } else add("word_limit", "Word count (main text)", "pass", `${fmt(body)} words (no limit set).`);

  if (abstractMaxWords && model.words.abstract != null) {
    add("abstract_limit", `${model.words.abstractSection ?? "Abstract"} length`, model.words.abstract > abstractMaxWords ? "fail" : "pass", `${fmt(model.words.abstract)} of ${fmt(abstractMaxWords)} words.`);
  }
  const overSections = model.sections.filter((s) => s.section.wordLimit && s.words > s.section.wordLimit && !(model.words.abstractSection === s.section.title && abstractMaxWords));
  if (overSections.length) add("section_limits", "Section word limits", "fail", overSections.map((s) => `${s.section.title}: ${fmt(s.words)} of ${fmt(s.section.wordLimit!)}`).join("; "));

  add("citations_resolved", "Citations point to library records", model.unknownKeys.length ? "fail" : "pass", model.unknownKeys.length ? `Not in the library: ${model.unknownKeys.join(", ")}.` : `${model.citedKeys.length} source${model.citedKeys.length === 1 ? "" : "s"} cited; all in the project library.`);
  const failed = model.citedKeys.filter((k) => v.refStatus.get(k)?.verificationStatus === "verification_failed");
  const unverified = model.citedKeys.filter((k) => ["unverified", "metadata_retrieved"].includes(v.refStatus.get(k)?.verificationStatus ?? ""));
  add(
    "citation_verification",
    "Cited sources verified",
    failed.length ? "fail" : unverified.length ? "warn" : "pass",
    failed.length ? `Failed verification: ${failed.join(", ")}.${unverified.length ? ` Not yet verified: ${unverified.join(", ")}.` : ""}` : unverified.length ? `Not yet verified against the DOI registry: ${unverified.join(", ")}.` : model.citedKeys.length ? "Every cited source has verified metadata or a reviewed full text." : "No citations.",
  );
  const problems = model.sections.flatMap((s) => s.problems.map((p) => `${s.section.title}: ${p}`));
  if (problems.length || v.missingFigures.length) add("figures", "Figures", "fail", [...problems, ...(v.missingFigures.length ? [`${v.missingFigures.length} figure file(s) missing or not PNG/JPEG.`] : [])].join(" "));
  else if (model.counts.figures) add("figures", "Figures", "pass", `${model.counts.figures} figure(s) embedded.`);

  if (!v.pages) return checks;

  // --- Rendered output (PDF) ----------------------------------------------
  const pages = v.pages;
  const size = PAGE_MM[spec.page.size];
  const wantW = size.w * PT_PER_MM;
  const wantH = size.h * PT_PER_MM;
  const wrongSize = pages.map((p, i) => (Math.abs(p.width - wantW) > 2 || Math.abs(p.height - wantH) > 2 ? i + 1 : 0)).filter(Boolean);
  add("page_size", "Page size", wrongSize.length ? "fail" : "pass", wrongSize.length ? `Pages ${wrongSize.join(", ")} are not ${spec.page.size}.` : `${spec.page.size} throughout.`);

  const maxPages = spec.limits.maxPages;
  add("page_count", "Page count", maxPages && pages.length > maxPages ? "fail" : "pass", `${pages.length} page${pages.length === 1 ? "" : "s"}${maxPages ? ` of ${maxPages} allowed` : ""}.`);

  const left = spec.page.marginsMm.left * PT_PER_MM;
  const right = wantW - spec.page.marginsMm.right * PT_PER_MM;
  const tol = 3;
  const overflow: string[] = [];
  pages.forEach((p, i) => {
    const textOut = p.items.filter((t) => t.x < left - tol || t.x + t.w > right + tol || t.y < 0 || t.y > p.height);
    const imgOut = p.images.filter((im) => im.x0 < left - tol || im.x1 > right + tol || im.y0 < -tol || im.y1 > p.height + tol);
    if (textOut.length || imgOut.length) overflow.push(`page ${i + 1}${textOut[0] ? ` (“${textOut[0].str.slice(0, 30)}”)` : " (image)"}`);
  });
  add("overflow", "Content within margins", overflow.length ? "fail" : "pass", overflow.length ? `Extends past the margins on ${overflow.slice(0, 6).join(", ")}${overflow.length > 6 ? "…" : ""}.` : "No text, table or image extends past the margins.");

  // Headings appear, in order.
  const flat = norm(pages.map((p) => p.text).join("\n"));
  const tocSection = model.sections.find((s) => s.section.kind === "toc");
  // Skip the contents page itself so headings are matched in the body.
  const tocPageIdx = tocSection ? pages.findIndex((p) => norm(p.text).startsWith(norm(tocSection.heading))) : -1;
  const bodyText = norm(pages.slice(tocPageIdx + 1).map((p) => p.text).join("\n"));
  let cursor = 0;
  const missing: string[] = [];
  for (const h of model.headings.filter((x) => x.text)) {
    if (tocSection && h.text === tocSection.heading) continue;
    const at = bodyText.indexOf(norm(h.text), cursor);
    if (at < 0) missing.push(h.text);
    else cursor = at;
  }
  add("headings", "Headings and numbering", missing.length ? "fail" : "pass", missing.length ? `Not found in order: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.` : `${model.headings.length} headings present in order${spec.headingNumbering ? ", numbered" : ""}.`);

  if (tocSection) {
    const tocText = tocPageIdx >= 0 ? norm(pages[tocPageIdx]!.text) : "";
    const firstChapter = model.headings.find((h) => h.level === 1 && h.text !== tocSection.heading);
    const ok = v.tocUpdated !== false && !!firstChapter && tocText.includes(norm(firstChapter.text));
    add("toc", "Table of contents", ok ? "pass" : "warn", ok ? "Generated with page numbers." : "The contents page could not be filled in by the renderer; it will update when the DOCX is opened in Word.");
  }

  const tableCaps = (flat.match(/\btable \d+\b/g) ?? []).length;
  if (model.counts.tables) add("tables", "Tables", tableCaps >= model.counts.tables ? "pass" : "fail", `${model.counts.tables} table(s); ${tableCaps >= model.counts.tables ? "all captions present" : "some captions missing in the output"}.`);
  if (model.counts.figures) {
    const drawn = pages.reduce((a, p) => a + p.images.length, 0);
    add("figures_rendered", "Figures rendered", drawn >= model.counts.figures - v.missingFigures.length ? "pass" : "fail", `${drawn} image(s) drawn for ${model.counts.figures} figure(s).`);
  }

  // Page numbers: the expected number is printed in the header/footer band.
  if (spec.pageNumbers.position !== "none") {
    const top = spec.pageNumbers.position === "top-right";
    const band = (p: PdfPage) => p.items.filter((t) => (top ? t.y > p.height - spec.page.marginsMm.top * PT_PER_MM : t.y < spec.page.marginsMm.bottom * PT_PER_MM)).map((t) => t.str.trim().toLowerCase());
    const hasTitle = spec.titlePage;
    const prelimCount = spec.pageNumbers.prelims === "roman" ? model.sections.filter((s) => (s.section.kind === "front" || s.section.kind === "toc") && !isEmptyOptional(s)).length : 0;
    let mainStart = hasTitle ? 1 : 0;
    if (prelimCount) {
      // Prelims end where the first arabic "1" appears.
      const idx = pages.findIndex((p, i) => i >= mainStart && band(p).includes("1"));
      mainStart = idx >= 0 ? idx : mainStart;
    }
    const wrong: number[] = [];
    pages.forEach((p, i) => {
      if (hasTitle && i === 0) return;
      const expected = i >= mainStart ? String(i - mainStart + 1) : roman(i - (hasTitle ? 1 : 0) + 1);
      if (!band(p).includes(expected)) wrong.push(i + 1);
    });
    add("page_numbers", "Page numbering", wrong.length ? "fail" : "pass", wrong.length ? `Missing or wrong on page${wrong.length === 1 ? "" : "s"} ${wrong.slice(0, 8).join(", ")}${wrong.length > 8 ? "…" : ""}.` : `${prelimCount ? "Roman numerals on preliminary pages, then " : ""}arabic numbering from the main text.`);
  }

  const blank = pages.map((p, i) => (p.items.length === 0 && p.images.length === 0 ? i + 1 : 0)).filter(Boolean);
  if (blank.length) add("blank_pages", "Blank pages", "warn", `Page${blank.length === 1 ? "" : "s"} ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} blank.`);
  return checks;
}
