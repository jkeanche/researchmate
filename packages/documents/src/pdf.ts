import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

function scriptPath(): string {
  const candidates = [process.env.LO_CONVERT_SCRIPT, join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lo_convert.py")];
  for (let d = process.cwd(), i = 0; i < 6; i++, d = dirname(d)) candidates.push(join(d, "packages", "documents", "scripts", "lo_convert.py"));
  return candidates.find((c) => c && existsSync(c)) ?? candidates[1]!;
}

let unoOk: boolean | undefined;
async function hasUno(): Promise<boolean> {
  unoOk ??= await run("python3", ["-c", "import uno"]).then(
    () => true,
    () => false,
  );
  return unoOk;
}

export async function hasLibreOffice(): Promise<boolean> {
  return run(process.env.SOFFICE_PATH ?? "soffice", ["--version"], { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
}

/**
 * Renders DOCX to PDF with LibreOffice in its own throwaway profile, so
 * concurrent jobs never share state. With Python-UNO available the contents
 * page is updated before export; otherwise a plain conversion is used and
 * `tocUpdated` is false.
 */
export async function docxToPdf(docx: Buffer, timeoutMs = 180_000): Promise<{ pdf: Buffer; tocUpdated: boolean }> {
  const soffice = process.env.SOFFICE_PATH ?? "soffice";
  const dir = await mkdtemp(join(tmpdir(), "rm-pdf-"));
  const src = join(dir, "document.docx");
  const dst = join(dir, "document.pdf");
  const profile = pathToFileURL(join(dir, "profile")).href;
  await writeFile(src, docx);
  try {
    if (await hasUno()) {
      const pipe = `rm_${randomUUID().replace(/-/g, "")}`;
      // Own process group: soffice forks soffice.bin, and both must be gone before the profile is removed.
      const office = spawn(soffice, ["--headless", "--invisible", "--nologo", "--norestore", "--nodefault", "--nolockcheck", `-env:UserInstallation=${profile}`, `--accept=pipe,name=${pipe};urp;`], { stdio: "ignore", detached: true });
      const exited = new Promise<void>((resolve) => office.once("exit", () => resolve()));
      try {
        await run("python3", [scriptPath(), pipe, src, dst], { timeout: timeoutMs });
      } finally {
        try {
          if (office.pid) process.kill(-office.pid, "SIGKILL");
        } catch {
          office.kill("SIGKILL");
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      return { pdf: await readFile(dst), tocUpdated: true };
    }
    await run(soffice, ["--headless", "--norestore", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", dir, src], { timeout: timeoutMs });
    return { pdf: await readFile(dst), tocUpdated: false };
  } finally {
    // Cleanup never fails a conversion that succeeded.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfPage {
  width: number;
  height: number;
  items: PdfTextItem[];
  images: { x0: number; y0: number; x1: number; y1: number }[];
  /** Text joined in reading order, one line per text line. */
  text: string;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

/** Reads the rendered PDF: page sizes, positioned text and image bounding boxes. */
export async function inspectPdf(pdf: Buffer): Promise<PdfPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      let text = "";
      for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }[]) {
        if (it.str === undefined) continue;
        text += it.str + (it.hasEOL ? "\n" : "");
        if (!it.str.trim() || !it.transform) continue;
        items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, h: it.height ?? 0 });
      }
      const ops = await page.getOperatorList();
      const images: PdfPage["images"] = [];
      const stack: M[] = [];
      let ctm: M = [1, 0, 0, 1, 0, 0];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (fn === pdfjs.OPS.transform) ctm = mul(ops.argsArray[i] as M, ctm);
        else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) {
          const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
          const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
          images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
        }
      }
      pages.push({ width: x1 - x0, height: y1 - y0, items, images, text });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}
