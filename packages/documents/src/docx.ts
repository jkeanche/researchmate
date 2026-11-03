import { htmlToRuns } from "@researchmate/citations";
import type { DocumentSpec } from "@researchmate/database";
import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  type ISectionOptions,
  LevelFormat,
  LineRuleType,
  NumberFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  SectionType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
} from "docx";
import { type Assembled, clusterFallback, isEmptyOptional, type NumberedBlock } from "./model";
import { texToText } from "./tex";
import type { Inline } from "./markup";
import { PAGE_MM } from "./spec";

export interface FigureData {
  data: Buffer;
  type: "png" | "jpg";
  width: number;
  height: number;
}

export interface DocxInput {
  title: string;
  meta: Record<string, string>;
  spec: DocumentSpec;
  model: Assembled;
  figures: Map<string, FigureData | null>;
}

const half = (pt: number) => Math.round(pt * 2);
const twipPt = (pt: number) => Math.round(pt * 20);
const NUMERIC_STYLES = new Set(["ieee", "vancouver"]);

/** Reads pixel dimensions from PNG or JPEG data. */
export function imageSize(buf: Buffer): { type: "png" | "jpg"; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** Builds the editable DOCX master. Headings, captions and numbering come from the assembled model. */
export async function buildDocx(input: DocxInput): Promise<Buffer> {
  const { spec, model } = input;
  const page = PAGE_MM[spec.page.size];
  const m = spec.page.marginsMm;
  const textWidthMm = page.w - m.left - m.right;
  const textWidthTwip = convertMillimetersToTwip(textWidthMm);
  const textWidthPx = Math.floor((textWidthMm / 25.4) * 96);
  const maxImgHeightPx = Math.floor(((page.h - m.top - m.bottom) / 25.4) * 96 * 0.6);
  const font = spec.font.family;
  let listInstance = 0;

  const runs = (inl: Inline[], base: { bold?: boolean; italics?: boolean } = {}): ParagraphChild[] => {
    const out: ParagraphChild[] = [];
    for (const x of inl) {
      if (x.t === "text") out.push(new TextRun({ text: x.v, bold: base.bold || x.b, italics: base.italics || x.i, font: x.code ? "Courier New" : undefined }));
      else {
        const c = model.clusters[x.cluster]!;
        const html = model.citationText.get(c.id);
        if (!html) out.push(new TextRun({ text: clusterFallback(c), bold: true }));
        else for (const r of htmlToRuns(html)) out.push(new TextRun({ text: r.text, italics: base.italics || r.italics, bold: base.bold || r.bold, superScript: r.superScript, smallCaps: r.smallCaps }));
      }
    }
    return out;
  };

  const body = (children: ParagraphChild[], extra: Record<string, unknown> = {}) =>
    new Paragraph({ children, indent: spec.paragraph.firstLineIndentMm ? { firstLine: convertMillimetersToTwip(spec.paragraph.firstLineIndentMm) } : undefined, ...extra });

  const caption = (label: string, num: string, inl: Inline[], keepNext: boolean) =>
    new Paragraph({ style: "Caption", keepNext, children: [new TextRun({ text: `${label} ${num}`, bold: true }), ...(inl.length ? [new TextRun({ text: ". " }), ...runs(inl)] : [])] });

  const renderBlocks = (blocks: NumberedBlock[]): (Paragraph | Table)[] => {
    const out: (Paragraph | Table)[] = [];
    for (const b of blocks) {
      switch (b.t) {
        case "p":
          out.push(body(runs(b.inl)));
          break;
        case "h": {
          const text = b.number ? (b.number.startsWith("Appendix") ? `${b.number}: ` : `${b.number} `) : "";
          out.push(new Paragraph({ heading: b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, children: [...(text ? [new TextRun(text)] : []), ...runs(b.inl)] }));
          break;
        }
        case "quote":
          out.push(new Paragraph({ style: "Quote", children: runs(b.inl) }));
          break;
        case "list": {
          const instance = ++listInstance;
          for (const it of b.items) out.push(new Paragraph({ children: runs(it), numbering: { reference: b.ordered ? "numbered" : "bullets", level: 0, instance } }));
          break;
        }
        case "table": {
          const cols = Math.max(1, b.rows[0]?.length ?? 1);
          const colW = Math.floor(textWidthTwip / cols);
          const border = { style: BorderStyle.SINGLE, size: 4, color: "808080" };
          const table = new Table({
            width: { size: textWidthTwip, type: WidthType.DXA },
            columnWidths: Array.from({ length: cols }, () => colW),
            layout: TableLayoutType.FIXED,
            margins: { top: 40, bottom: 40, left: 90, right: 90 },
            borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
            rows: b.rows.map(
              (row, ri) =>
                new TableRow({
                  tableHeader: b.header && ri === 0,
                  cantSplit: true,
                  children: row.map((cell) => new TableCell({ width: { size: colW, type: WidthType.DXA }, children: [new Paragraph({ style: "TableText", children: runs(cell, { bold: b.header && ri === 0 }) })] })),
                }),
            ),
          });
          if (spec.captions.table === "above") out.push(caption("Table", b.number!, b.caption, true), table);
          else out.push(table, caption("Table", b.number!, b.caption, false));
          break;
        }
        case "figure": {
          const f = input.figures.get(b.fileId);
          let pic: Paragraph;
          if (f) {
            const scale = Math.min(1, textWidthPx / f.width, maxImgHeightPx / f.height);
            pic = new Paragraph({ alignment: AlignmentType.CENTER, keepNext: spec.captions.figure === "below", spacing: { line: 240, lineRule: LineRuleType.AUTO, before: twipPt(6), after: 0 }, children: [new ImageRun({ type: f.type, data: f.data, transformation: { width: Math.round(f.width * scale), height: Math.round(f.height * scale) } })] });
          } else pic = new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "[Figure file missing or not a PNG/JPEG image]", bold: true })] });
          if (spec.captions.figure === "above") out.push(caption("Figure", b.number!, b.caption, true), pic);
          else out.push(pic, caption("Figure", b.number!, b.caption, false));
          break;
        }
        case "eq":
          out.push(
            new Paragraph({
              tabStops: [
                { type: TabStopType.CENTER, position: Math.floor(textWidthTwip / 2) },
                { type: TabStopType.RIGHT, position: textWidthTwip },
              ],
              children: [new TextRun({ children: [new Tab(), texToText(b.tex)], italics: true, font: "Cambria Math" }), new TextRun({ children: [new Tab(), `(${b.number})`] })],
            }),
          );
          break;
        case "break":
          out.push(new Paragraph({ children: [new PageBreak()] }));
          break;
      }
    }
    return out;
  };

  const pageNumberParagraph = () =>
    new Paragraph({
      alignment: spec.pageNumbers.position === "bottom-center" ? AlignmentType.CENTER : AlignmentType.RIGHT,
      children: [new TextRun({ children: [PageNumber.CURRENT] })],
    });
  const header = (withNumber: boolean) => {
    const kids: Paragraph[] = [];
    if (spec.header) kids.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.header, size: half(Math.max(8, spec.font.sizePt - 2)) })] }));
    if (withNumber && spec.pageNumbers.position === "top-right") kids.push(pageNumberParagraph());
    return kids.length ? new Header({ children: kids }) : undefined;
  };
  const footer = (withNumber: boolean) => {
    const kids: Paragraph[] = [];
    if (withNumber && spec.pageNumbers.position.startsWith("bottom")) kids.push(pageNumberParagraph());
    if (spec.footer) kids.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.footer, size: half(Math.max(8, spec.font.sizePt - 2)) })] }));
    return kids.length ? new Footer({ children: kids }) : undefined;
  };

  const meta = input.meta;
  const titleBlock = (full: boolean): Paragraph[] => {
    const lines: Paragraph[] = [];
    const center = (text: string, opts: { size?: number; bold?: boolean; before?: number; italics?: boolean } = {}) =>
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: twipPt(opts.before ?? 0), after: twipPt(6) }, children: [new TextRun({ text, size: opts.size ? half(opts.size) : undefined, bold: opts.bold, italics: opts.italics })] });
    lines.push(center(input.title, { size: spec.font.sizePt + (full ? 8 : 4), bold: true, before: full ? 120 : 0 }));
    if (meta.subtitle) lines.push(center(meta.subtitle, { size: spec.font.sizePt + 2 }));
    if (meta.author) lines.push(center(meta.author, { before: full ? 48 : 6 }));
    if (full) {
      if (meta.degree) lines.push(center(`A ${meta.documentLabel || "dissertation"} submitted in partial fulfilment of the requirements for the degree of ${meta.degree}`, { before: 48, italics: true }));
      if (meta.department) lines.push(center(meta.department, { before: meta.degree ? 24 : 48 }));
      if (meta.institution) lines.push(center(meta.institution));
      if (meta.supervisor) lines.push(center(`Supervisor: ${meta.supervisor}`, { before: 24 }));
      if (meta.date) lines.push(center(meta.date, { before: 24 }));
    } else {
      const aff = [meta.department, meta.institution].filter(Boolean).join(", ");
      if (aff) lines.push(center(aff, { italics: true }));
    }
    return lines;
  };

  const sectionHeading = (heading: string, pageBreak: boolean) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: pageBreak, children: [new TextRun(heading)] });

  const bibliography = (): Paragraph[] => {
    const numeric = NUMERIC_STYLES.has(spec.citationStyle);
    return model.bibliography.map((html) => {
      const cleaned = html.replace(/<div class="csl-left-margin">([\s\S]*?)<\/div>/g, "$1 ");
      return new Paragraph({ indent: { left: 720, hanging: 720 }, spacing: { after: twipPt(numeric ? 2 : 6) }, children: htmlToRuns(cleaned).map((r) => new TextRun({ text: r.text.replace(/\s+/g, " "), italics: r.italics, bold: r.bold, superScript: r.superScript, smallCaps: r.smallCaps })) });
    });
  };

  // Group sections into Word sections: title page, preliminary pages (roman), main text (arabic).
  const thesis = spec.titlePage;
  const titleChildren: (Paragraph | Table | TableOfContents)[] = [];
  const prelim: (Paragraph | Table | TableOfContents)[] = [];
  const main: (Paragraph | Table | TableOfContents)[] = [];
  const separatePrelims = spec.pageNumbers.prelims === "roman";
  let firstMain = true;
  for (const s of model.sections) {
    const kind = s.section.kind;
    if (isEmptyOptional(s)) continue;
    if (kind === "title") {
      (thesis ? titleChildren : main).push(...titleBlock(thesis));
      continue;
    }
    const target = (kind === "front" || kind === "toc") && separatePrelims ? prelim : main;
    const isFirstInTarget = target.length === 0;
    const breakBefore = thesis ? !isFirstInTarget : false;
    if (kind === "toc") {
      target.push(new Paragraph({ style: "PrelimHeading", pageBreakBefore: breakBefore, children: [new TextRun(s.heading)] }), new TableOfContents(s.heading, { hyperlink: true, headingStyleRange: "1-3" }));
      continue;
    }
    if (kind === "front") {
      // Preliminary headings are unnumbered and not listed in the contents.
      target.push(new Paragraph({ style: "PrelimHeading", pageBreakBefore: breakBefore, children: [new TextRun(s.heading)] }), ...renderBlocks(s.blocks));
      continue;
    }
    if (kind === "references") {
      if (!model.bibliography.length) continue;
      target.push(sectionHeading(s.heading, thesis && !(target === main && firstMain)), ...bibliography());
      firstMain = false;
      continue;
    }
    if (kind === "appendix" && !s.blocks.length) continue;
    target.push(sectionHeading(s.heading, thesis && !(target === main && firstMain)), ...renderBlocks(s.blocks));
    if (target === main) firstMain = false;
  }

  const pageProps = (start?: number, format?: (typeof NumberFormat)[keyof typeof NumberFormat]) => ({
    page: {
      size: { width: convertMillimetersToTwip(page.w), height: convertMillimetersToTwip(page.h) },
      margin: { top: convertMillimetersToTwip(m.top), bottom: convertMillimetersToTwip(m.bottom), left: convertMillimetersToTwip(m.left), right: convertMillimetersToTwip(m.right), header: convertMillimetersToTwip(Math.max(8, m.top / 2)), footer: convertMillimetersToTwip(Math.max(8, m.bottom / 2)) },
      ...(start ? { pageNumbers: { start, formatType: format } } : {}),
    },
  });
  const numbersOn = spec.pageNumbers.position !== "none";
  const wordSections: ISectionOptions[] = [];
  if (titleChildren.length) wordSections.push({ properties: { ...pageProps() }, children: titleChildren, headers: { default: header(false) ?? new Header({ children: [] }) }, footers: { default: new Footer({ children: [] }) } });
  if (prelim.length) wordSections.push({ properties: { ...pageProps(1, NumberFormat.LOWER_ROMAN), type: SectionType.NEXT_PAGE }, children: prelim, headers: { default: header(numbersOn) ?? new Header({ children: [] }) }, footers: { default: footer(numbersOn) ?? new Footer({ children: [] }) } });
  wordSections.push({
    properties: { ...pageProps(1, NumberFormat.DECIMAL), type: wordSections.length ? SectionType.NEXT_PAGE : undefined },
    children: main.length ? main : [new Paragraph("")],
    headers: { default: header(numbersOn) ?? new Header({ children: [] }) },
    footers: { default: footer(numbersOn) ?? new Footer({ children: [] }) },
  });

  const line = Math.round(240 * spec.lineSpacing);
  const hFont = spec.headingFont;
  const doc = new Document({
    title: input.title,
    creator: meta.author || "ResearchMate",
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font, size: half(spec.font.sizePt) }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO, before: twipPt(spec.paragraph.spaceBeforePt), after: twipPt(spec.paragraph.spaceAfterPt) } } },
        heading1: { run: { font: hFont, size: half(spec.font.sizePt + 4), bold: true }, paragraph: { spacing: { before: twipPt(18), after: twipPt(12), line: 240, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true, outlineLevel: 0 } },
        heading2: { run: { font: hFont, size: half(spec.font.sizePt + 2), bold: true }, paragraph: { spacing: { before: twipPt(12), after: twipPt(6), line: 240, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true, outlineLevel: 1 } },
        heading3: { run: { font: hFont, size: half(spec.font.sizePt), bold: true, italics: true }, paragraph: { spacing: { before: twipPt(10), after: twipPt(4), line: 240, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true, outlineLevel: 2 } },
      },
      paragraphStyles: [
        { id: "Caption", name: "Caption", basedOn: "Normal", next: "Normal", run: { size: half(Math.max(8, spec.font.sizePt - 1)) }, paragraph: { spacing: { before: twipPt(6), after: twipPt(6), line: 240, lineRule: LineRuleType.AUTO } } },
        { id: "Quote", name: "Quote", basedOn: "Normal", next: "Normal", paragraph: { indent: { left: 720, right: 720 }, spacing: { line: 240, lineRule: LineRuleType.AUTO } } },
        { id: "TableText", name: "Table Text", basedOn: "Normal", run: { size: half(Math.max(8, spec.font.sizePt - 1)) }, paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } } },
        { id: "PrelimHeading", name: "Preliminary Heading", basedOn: "Normal", next: "Normal", run: { font: hFont, size: half(spec.font.sizePt + 4), bold: true }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: twipPt(18), after: twipPt(12), line: 240, lineRule: LineRuleType.AUTO }, keepNext: true } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: "numbered", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: wordSections,
  });
  return Packer.toBuffer(doc);
}
