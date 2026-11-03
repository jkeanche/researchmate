import { type CitationCluster, type CslItem, formatDocument } from "@researchmate/citations";
import type { DocumentSpec, SectionKind } from "@researchmate/database";
import { type Block, countWords, type Inline, inlineText, parseMarkup } from "./markup";

export interface SectionInput {
  id: string;
  key: string;
  title: string;
  kind: SectionKind;
  content: string;
  required: boolean;
  wordLimit: number | null;
}

export interface RefInput {
  id: string;
  key: string;
  csl: Record<string, unknown>;
  verificationStatus: string;
  accessLevel: string;
}

/** A block with its computed number: "2.1" for headings, "3" for tables/figures/equations, "A" for appendices. */
export type NumberedBlock = Block & { number?: string };

export interface AssembledSection {
  section: SectionInput;
  /** Chapter number ("3") for numbered body sections, otherwise "". */
  number: string;
  /** Heading text as it appears in the output, e.g. "3 Methodology". */
  heading: string;
  blocks: NumberedBlock[];
  words: number;
  problems: string[];
}

export interface Assembled {
  sections: AssembledSection[];
  clusters: CitationCluster[];
  /** Cluster id → formatted in-text citation (html or text). */
  citationText: Map<string, string>;
  bibliography: string[];
  citedKeys: string[];
  unknownKeys: string[];
  words: { body: number; abstract: number | null; abstractSection: string | null };
  counts: { tables: number; figures: number; equations: number };
  figureIds: string[];
  /** Every heading in output order, for validation: [text, level]. */
  headings: { text: string; level: 1 | 2 | 3 }[];
}

const ABSTRACT_KEYS = ["abstract", "summary"];

/**
 * Turns sections into a numbered, citation-resolved document model. The same
 * model drives the browser preview, the DOCX writer and output validation, so
 * what is checked is what is rendered.
 */
export function assemble(spec: DocumentSpec, sections: SectionInput[], refs: RefInput[], format: "html" | "text" = "html"): Assembled {
  const byKey = new Map(refs.map((r) => [r.key, r]));
  const clusters: CitationCluster[] = [];
  const out: AssembledSection[] = [];
  const headings: Assembled["headings"] = [];
  let chapter = 0;
  let tables = 0;
  let figures = 0;
  let equations = 0;
  const figureIds: string[] = [];

  for (const section of sections) {
    const parsed = parseMarkup(section.kind === "title" || section.kind === "toc" || section.kind === "references" ? "" : section.content);
    // Re-index local clusters into document-wide clusters.
    const base = clusters.length;
    parsed.clusters.forEach((items, n) => clusters.push({ id: `c${base + n + 1}`, items: items.map((it) => ({ id: it.key, locator: it.locator, label: it.label, prefix: it.prefix, suppressAuthor: it.suppressAuthor })) }));
    const remap = (inl: Inline[]): Inline[] => inl.map((x) => (x.t === "cite" ? { t: "cite", cluster: x.cluster + base } : x));

    const emptyOptional = !section.required && ["front", "body", "appendix"].includes(section.kind) && parsed.blocks.length === 0;
    const numbered = section.kind === "body" && spec.headingNumbering && !emptyOptional;
    const number = numbered ? String(++chapter) : "";
    const heading = section.kind === "title" ? "" : number ? `${number} ${section.title}` : section.title;
    if (heading && !emptyOptional && section.kind !== "front" && section.kind !== "toc") headings.push({ text: heading, level: 1 });
    let sub = 0;
    let subsub = 0;
    let appendix = 0;
    const blocks: NumberedBlock[] = parsed.blocks.map((b): NumberedBlock => {
      switch (b.t) {
        case "h": {
          const inl = remap(b.inl);
          let num: string | undefined;
          if (section.kind === "appendix" && b.level === 2) num = `Appendix ${String.fromCharCode(65 + appendix++)}`;
          else if (numbered && b.level === 2) {
            num = `${number}.${++sub}`;
            subsub = 0;
          } else if (numbered && b.level === 3) num = `${number}.${sub}.${++subsub}`;
          const text = num ? (num.startsWith("Appendix") ? `${num}: ${inlineText(inl)}` : `${num} ${inlineText(inl)}`) : inlineText(inl);
          headings.push({ text, level: b.level });
          return { ...b, inl, number: num };
        }
        case "p":
        case "quote":
          return { ...b, inl: remap(b.inl) };
        case "list":
          return { ...b, items: b.items.map(remap) };
        case "table":
          return { ...b, caption: remap(b.caption), rows: b.rows.map((r) => r.map(remap)), number: String(++tables) };
        case "figure":
          figureIds.push(b.fileId);
          return { ...b, caption: remap(b.caption), number: String(++figures) };
        case "eq":
          return { ...b, number: String(++equations) };
        default:
          return b;
      }
    });
    out.push({ section, number, heading, blocks, words: countWords(parsed.blocks), problems: parsed.problems });
  }

  const cited: string[] = [];
  for (const c of clusters) for (const it of c.items) if (!cited.includes(it.id)) cited.push(it.id);
  const unknownKeys = cited.filter((k) => !byKey.has(k));
  const items: CslItem[] = cited.filter((k) => byKey.has(k)).map((k) => ({ ...(byKey.get(k)!.csl as CslItem), id: k }));
  const formatted = formatDocument(spec.citationStyle, items, clusters, { format });

  const abstract = out.find((s) => s.section.kind === "front" && ABSTRACT_KEYS.includes(s.section.key));
  return {
    sections: out,
    clusters,
    citationText: formatted.citations,
    bibliography: formatted.bibliography,
    citedKeys: cited.filter((k) => byKey.has(k)),
    unknownKeys,
    words: { body: out.filter((s) => s.section.kind === "body").reduce((a, s) => a + s.words, 0), abstract: abstract?.words ?? null, abstractSection: abstract?.section.title ?? null },
    counts: { tables, figures, equations },
    figureIds,
    headings,
  };
}

/** Optional writing sections left empty are left out of the output (generated sections are kept). */
export const isEmptyOptional = (s: AssembledSection) => !s.section.required && ["front", "body", "appendix"].includes(s.section.kind) && s.blocks.length === 0;

/** Unknown-key placeholder used wherever a cluster could not be formatted. */
export function clusterFallback(c: CitationCluster): string {
  return `[${c.items.map((i) => `?${i.id}`).join("; ")}]`;
}
