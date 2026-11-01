import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";

/**
 * Upload allowlist. The detected content (magic bytes) must agree with the
 * file extension; the client-declared MIME type is ignored.
 */
export const ALLOWED_TYPES: Record<string, { mime: string; label: string; kind: "binary" | "text" }> = {
  ".pdf": { mime: "application/pdf", label: "PDF", kind: "binary" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", kind: "binary" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel workbook", kind: "binary" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint", kind: "binary" },
  ".png": { mime: "image/png", label: "PNG image", kind: "binary" },
  ".jpg": { mime: "image/jpeg", label: "JPEG image", kind: "binary" },
  ".jpeg": { mime: "image/jpeg", label: "JPEG image", kind: "binary" },
  ".csv": { mime: "text/csv", label: "CSV", kind: "text" },
  ".txt": { mime: "text/plain", label: "Text", kind: "text" },
  ".md": { mime: "text/markdown", label: "Markdown", kind: "text" },
  ".bib": { mime: "application/x-bibtex", label: "BibTeX", kind: "text" },
  ".ris": { mime: "application/x-research-info-systems", label: "RIS", kind: "text" },
};

export const ACCEPT_ATTRIBUTE = Object.keys(ALLOWED_TYPES).join(",");

export class UnsupportedFileTypeError extends Error {}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  // Must decode as UTF-8 (allowing a split multi-byte character at the end of the sample).
  const sample = head.subarray(0, Math.max(0, head.length - 4));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the canonical MIME type for an upload, or throws when the content
 * is not on the allowlist or does not match its extension.
 */
export async function detectContentType(filename: string, head: Buffer): Promise<string> {
  const ext = extname(filename).toLowerCase();
  const allowed = ALLOWED_TYPES[ext];
  if (!allowed) {
    throw new UnsupportedFileTypeError(`Files of type "${ext || "unknown"}" are not supported. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}.`);
  }
  const detected = await fileTypeFromBuffer(head);
  if (allowed.kind === "text") {
    if (detected || !looksLikeText(head)) throw new UnsupportedFileTypeError(`The file content does not look like ${allowed.label}.`);
    return allowed.mime;
  }
  if (!detected) throw new UnsupportedFileTypeError(`The file content does not look like a ${allowed.label}.`);
  // OOXML containers are sometimes only recognisable as ZIP from a short sample.
  const ooxml = [".docx", ".xlsx", ".pptx"].includes(ext);
  if (detected.mime === allowed.mime || (ooxml && detected.mime === "application/zip")) return allowed.mime;
  throw new UnsupportedFileTypeError(`The file content (${detected.ext}) does not match its ${ext} extension.`);
}

/** Strips paths, control characters and dangerous characters from a user-supplied filename. */
export function sanitizeFilename(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) throw new UnsupportedFileTypeError("The file needs a name.");
  if (cleaned.length > 200) {
    const ext = extname(cleaned);
    return cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}
