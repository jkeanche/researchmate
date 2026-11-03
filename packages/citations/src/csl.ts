import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic citation formatting with citeproc-js and official CSL styles
 * (vendored in ../csl). Citations are processed as a whole document so
 * numbering (IEEE, Vancouver) and disambiguation (APA "2020a/2020b") are right.
 */

const require = createRequire(import.meta.url);
// citeproc ships as CommonJS without types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CSL: any = require("citeproc");

export const CITATION_STYLES = {
  apa7: { file: "apa.csl", name: "APA 7", locale: "en-US" },
  harvard: { file: "harvard-cite-them-right.csl", name: "Harvard (Cite Them Right)", locale: "en-GB" },
  mla: { file: "modern-language-association.csl", name: "MLA 9", locale: "en-US" },
  chicago: { file: "chicago-author-date.csl", name: "Chicago (author-date)", locale: "en-US" },
  ieee: { file: "ieee.csl", name: "IEEE", locale: "en-US" },
  vancouver: { file: "vancouver.csl", name: "Vancouver", locale: "en-US" },
} as const;
export type StyleKey = keyof typeof CITATION_STYLES;

/**
 * Where the vendored styles live. When this package is bundled (Next.js),
 * import.meta.url points into the build output, so fall back to CSL_DIR or to
 * packages/citations/csl found by walking up from the working directory.
 */
function findCslDir(): string {
  const candidates = [process.env.CSL_DIR, join(dirname(fileURLToPath(import.meta.url)), "..", "csl")];
  for (let d = process.cwd(), i = 0; i < 6; i++, d = dirname(d)) candidates.push(join(d, "packages", "citations", "csl"));
  return candidates.find((c) => c && existsSync(join(c, "apa.csl"))) ?? candidates[1]!;
}
let DIR_CACHE: string | undefined;
const dir = () => (DIR_CACHE ??= findCslDir());
const cache = new Map<string, string>();
const read = (f: string) => {
  if (!cache.has(f)) cache.set(f, readFileSync(join(dir(), f), "utf8"));
  return cache.get(f)!;
};

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}
/** CSL-JSON item (subset we use; extra fields pass through). */
export interface CslItem {
  id: string;
  type: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: { "date-parts": [number, number?, number?][] } | { literal: string };
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-place"?: string;
  DOI?: string;
  URL?: string;
  ISBN?: string;
  ISSN?: string;
  abstract?: string;
  edition?: string;
  accessed?: { "date-parts": [number, number?, number?][] };
  [k: string]: unknown;
}

export interface CitationCluster {
  id: string;
  items: { id: string; locator?: string; label?: string; prefix?: string; suffix?: string; suppressAuthor?: boolean }[];
}

export interface FormattedDocument {
  /** In-text citation text per cluster id, in the requested format. */
  citations: Map<string, string>;
  /** Bibliography entries in style order. */
  bibliography: string[];
  /** Item ids that were cited but have no data. */
  missing: string[];
}

function engine(style: StyleKey, items: Map<string, CslItem>, format: "html" | "text") {
  const s = CITATION_STYLES[style];
  const sys = {
    retrieveLocale: (lang: string) => read(lang.startsWith("en-GB") ? "locales-en-GB.xml" : "locales-en-US.xml"),
    retrieveItem: (id: string) => items.get(id),
  };
  const e = new CSL.Engine(sys, read(s.file), s.locale, true);
  e.setOutputFormat(format);
  return e;
}

/**
 * Formats every citation cluster in document order plus the bibliography of
 * cited items (or of `allIds` when given, e.g. for a reference list export).
 */
export function formatDocument(style: StyleKey, itemsIn: CslItem[], clusters: CitationCluster[], opts: { format?: "html" | "text"; allIds?: string[] } = {}): FormattedDocument {
  const items = new Map(itemsIn.map((i) => [i.id, i]));
  const missing = [...new Set(clusters.flatMap((c) => c.items.map((i) => i.id)).filter((id) => !items.has(id)))];
  const usable = clusters.map((c) => ({ ...c, items: c.items.filter((i) => items.has(i.id)) })).filter((c) => c.items.length);
  const e = engine(style, items, opts.format ?? "text");
  const citations = new Map<string, string>();
  if (usable.length) {
    const result: [string, number, string][] = e.rebuildProcessorState(
      usable.map((c) => ({
        citationID: c.id,
        citationItems: c.items.map((i) => ({ id: i.id, locator: i.locator, label: i.label ?? (i.locator ? "page" : undefined), prefix: i.prefix, suffix: i.suffix, "suppress-author": i.suppressAuthor })),
        properties: { noteIndex: 0 },
      })),
      opts.format ?? "text",
    );
    for (const [id, , text] of result) citations.set(id, text);
  }
  const extra = (opts.allIds ?? []).filter((id) => items.has(id));
  if (extra.length) e.updateUncitedItems(extra);
  const bib = e.makeBibliography();
  const bibliography: string[] = bib ? (bib[1] as string[]).map((s) => s.trim()) : [];
  return { citations, bibliography, missing };
}

/** Bibliography only (reference list), e.g. for exports. */
export function formatBibliography(style: StyleKey, items: CslItem[], format: "html" | "text" = "text"): string[] {
  return formatDocument(style, items, [], { format, allIds: items.map((i) => i.id) }).bibliography;
}

/** Splits citeproc HTML output into runs with basic formatting, for DOCX rendering. */
export function htmlToRuns(html: string): { text: string; italics?: boolean; bold?: boolean; superScript?: boolean; smallCaps?: boolean }[] {
  const runs: { text: string; italics?: boolean; bold?: boolean; superScript?: boolean; smallCaps?: boolean }[] = [];
  const state = { i: 0, b: 0, sup: 0, sc: 0 };
  const stack: (keyof typeof state | null)[] = [];
  const decode = (s: string) => s.replace(/&#38;|&amp;/g, "&").replace(/&#60;|&lt;/g, "<").replace(/&#62;|&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;|&#160;/g, " ");
  for (const part of html.replace(/<div[^>]*>|<\/div>/g, "").split(/(<[^>]+>)/)) {
    if (!part) continue;
    if (part.startsWith("<")) {
      const closing = part.startsWith("</");
      if (closing) {
        const k = stack.pop();
        if (k) state[k]--;
        continue;
      }
      const tag = part.slice(1).split(/[\s>]/)[0]!.toLowerCase();
      const k: keyof typeof state | null = tag === "i" || tag === "em" ? "i" : tag === "b" || tag === "strong" ? "b" : tag === "sup" ? "sup" : tag === "span" && /small-caps/.test(part) ? "sc" : tag === "span" && /italic/.test(part) ? "i" : null;
      if (!part.endsWith("/>")) {
        stack.push(k);
        if (k) state[k]++;
      }
      continue;
    }
    runs.push({ text: decode(part), italics: state.i > 0 || undefined, bold: state.b > 0 || undefined, superScript: state.sup > 0 || undefined, smallCaps: state.sc > 0 || undefined });
  }
  return runs;
}

export function htmlToText(html: string): string {
  return htmlToRuns(html)
    .map((r) => r.text)
    .join("");
}
