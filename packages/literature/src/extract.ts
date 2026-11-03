import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ExtractedPage {
  page: number | null;
  text: string;
  method: "text" | "ocr";
}

export const EXTRACTABLE = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown", "text/csv"]);

/**
 * Deterministic text extraction (no AI): PDF text layer per page with
 * pdf.js; DOCX via mammoth; plain text as-is. Scanned PDFs (no text layer)
 * fall back to OCR with poppler + Tesseract when both are installed and OCR
 * is enabled. Caps keep a hostile file from exhausting the worker.
 */
export async function extractText(buf: Buffer, mimeType: string, opts: { ocr?: boolean; maxPages?: number } = {}): Promise<ExtractedPage[]> {
  const maxPages = opts.maxPages ?? 500;
  if (mimeType === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    const doc = await task.promise;
    const pages: ExtractedPage[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      let text = "";
      for (const it of content.items as { str?: string; hasEOL?: boolean }[]) text += (it.str ?? "") + (it.hasEOL ? "\n" : " ");
      pages.push({ page: p, text: tidy(text), method: "text" });
    }
    await task.destroy();
    const chars = pages.reduce((a, p) => a + p.text.length, 0);
    if (chars < 20 * pages.length && opts.ocr) {
      const ocr = await ocrPdf(buf, Math.min(pages.length, 50));
      if (ocr) return ocr;
    }
    return pages;
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return [{ page: null, text: tidy(r.value), method: "text" }];
  }
  if (mimeType.startsWith("text/")) return [{ page: null, text: tidy(buf.toString("utf8")), method: "text" }];
  return [];
}

function tidy(s: string): string {
  return s.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

let ocrAvailable: boolean | undefined;
export async function hasOcr(): Promise<boolean> {
  if (ocrAvailable === undefined) {
    ocrAvailable = await Promise.all([run("tesseract", ["--version"]), run("pdftoppm", ["-v"])]).then(
      () => true,
      () => false,
    );
  }
  return ocrAvailable;
}

async function ocrPdf(buf: Buffer, pages: number): Promise<ExtractedPage[] | null> {
  if (!(await hasOcr())) return null;
  const dir = await mkdtemp(join(tmpdir(), "rm-ocr-"));
  try {
    await writeFile(join(dir, "in.pdf"), buf);
    await run("pdftoppm", ["-r", "200", "-gray", "-png", "-l", String(pages), join(dir, "in.pdf"), join(dir, "p")], { timeout: 120_000 });
    const images = (await readdir(dir)).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
    const out: ExtractedPage[] = [];
    for (const [i, img] of images.entries()) {
      await run("tesseract", [join(dir, img), join(dir, `t${i}`), "-l", "eng"], { timeout: 120_000 });
      out.push({ page: i + 1, text: tidy(await readFile(join(dir, `t${i}.txt`), "utf8")), method: "ocr" });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
