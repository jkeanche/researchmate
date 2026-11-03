import type { surveys } from "@researchmate/database";
import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import PptxGenJS from "pptxgenjs";
import type { ToolkitService } from "./service";

export type ProjectData = Awaited<ReturnType<ToolkitService["projectData"]>>;
export type DeckKind = "proposal" | "progress" | "defense";
export const DECK_KINDS: Record<DeckKind, string> = { proposal: "Proposal presentation", progress: "Progress update", defense: "Defense presentation" };

const INK = "1F2933";
const MUTED = "5F6B7A";
const ACCENT = "2F5D8A";
const FONT = "Calibri";
const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

/**
 * Builds a 16:9 deck from what is recorded in the project. Nothing is
 * invented: empty sections become a placeholder the researcher fills in.
 */
export async function buildDeck(d: ProjectData, kind: DeckKind): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = `${d.project.title} — ${DECK_KINDS[kind]}`;
  pptx.company = d.project.institution ?? "";
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };

  const title = pptx.addSlide();
  title.background = { color: "FFFFFF" };
  title.addShape("rect", { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } });
  title.addText(d.project.title, { x: 0.9, y: 2.2, w: 11.4, h: 1.6, fontSize: 36, bold: true, color: INK, fontFace: FONT, valign: "bottom", fit: "shrink" });
  title.addText(DECK_KINDS[kind], { x: 0.9, y: 3.95, w: 11.4, h: 0.5, fontSize: 20, color: ACCENT, fontFace: FONT });
  title.addText([d.project.department, d.project.institution].filter(Boolean).join(", ") || " ", { x: 0.9, y: 4.6, w: 11.4, h: 0.4, fontSize: 14, color: MUTED, fontFace: FONT });
  title.addText(fmtDate(d.today), { x: 0.9, y: 5.05, w: 11.4, h: 0.4, fontSize: 14, color: MUTED, fontFace: FONT });

  const bullets = (heading: string, items: string[], empty: string) => {
    const s = pptx.addSlide();
    s.addText(heading, { x: 0.6, y: 0.4, w: 12.1, h: 0.8, fontSize: 28, bold: true, color: INK, fontFace: FONT });
    s.addShape("line", { x: 0.6, y: 1.2, w: 1.2, h: 0, line: { color: ACCENT, width: 3 } });
    if (!items.length) {
      s.addText(empty, { x: 0.6, y: 1.6, w: 12.1, h: 1, fontSize: 18, italic: true, color: MUTED, fontFace: FONT });
      return s;
    }
    const shown = items.slice(0, 8);
    s.addText(
      shown.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y: 1.5, w: 12.1, h: 5.4, fontSize: shown.length > 5 ? 18 : 22, color: INK, fontFace: FONT, valign: "top", paraSpaceAfter: 10, fit: "shrink" },
    );
    return s;
  };

  const background = d.project.description?.trim() ? [d.project.description.trim()] : [];
  const objectives = d.objectives.map((o) => o.text);
  const questions = d.questions.map((q) => q.text);
  const method = d.project.methodology?.trim() ? [d.project.methodology.trim()] : [];

  if (kind === "proposal" || kind === "defense") {
    bullets("Background and problem", background, "Add the project description in Settings to fill this slide.");
    bullets("Research objectives", objectives, "No objectives recorded yet — add them on the Plan tab.");
    bullets("Research questions", questions, "No research questions recorded yet — add them on the Plan tab.");
    bullets("Methodology", method, "Record the methodology in project settings.");
  }
  if (kind === "proposal") {
    bullets("Timeline and milestones", d.milestones.map((m) => `${m.title} — ${fmtDate(m.date)}`), "No milestones scheduled yet.");
    bullets("Key risks and mitigation", d.risks.map((r) => (r.mitigation ? `${r.title}: ${r.mitigation}` : r.title)), "No open risks recorded.");
  }
  if (kind === "progress") {
    const pct = d.tasks.total ? Math.round((d.tasks.done / d.tasks.total) * 100) : 0;
    const s = pptx.addSlide();
    s.addText("Where the project stands", { x: 0.6, y: 0.4, w: 12.1, h: 0.8, fontSize: 28, bold: true, color: INK, fontFace: FONT });
    const stat = (x: number, value: string, label: string) => {
      s.addText(value, { x, y: 1.8, w: 3.6, h: 1.2, fontSize: 48, bold: true, color: ACCENT, fontFace: FONT, align: "center" });
      s.addText(label, { x, y: 3.0, w: 3.6, h: 0.5, fontSize: 16, color: MUTED, fontFace: FONT, align: "center" });
    };
    stat(0.6, `${d.project.progressPercent}%`, "Overall progress");
    stat(4.85, `${d.tasks.done}/${d.tasks.total}`, `Tasks complete (${pct}%)`);
    stat(9.1, String(d.referenceCount), "References in library");
    bullets("Stages", d.stages.filter((st) => st.enabled).map((st) => `${st.name} — ${st.status.replace(/_/g, " ")}`), "No stages yet.");
    bullets("Overdue", d.tasks.overdue.map((t) => `${t.title} (due ${fmtDate(t.due)})`), "Nothing is overdue.");
    bullets("Next steps", d.tasks.upcoming.map((t) => `${t.title} — due ${fmtDate(t.due)}${t.progress ? `, ${t.progress}% done` : ""}`), "No upcoming tasks.");
    bullets("Risks and issues", d.risks.map((r) => `${r.title} (likelihood ${r.likelihood}/5, impact ${r.impact}/5)`), "No open risks recorded.");
  }
  if (kind === "defense") {
    bullets("Findings", [], "Summarise the key findings here.");
    bullets("Contributions and implications", [], "Summarise the contributions here.");
    bullets("Limitations and future work", [], "Note limitations and future work here.");
  }
  const end = pptx.addSlide();
  end.addText(kind === "progress" ? "Discussion" : "Thank you — questions?", { x: 0.6, y: 3.0, w: 12.1, h: 1.2, fontSize: 36, bold: true, color: INK, fontFace: FONT, align: "center" });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as ArrayBuffer);
}

const p = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, font: FONT, size: opts.size ?? 22, bold: opts.bold, italics: opts.italics, color: opts.color })] });
const h = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, font: FONT })] });
const thin = { style: BorderStyle.SINGLE, size: 4, color: "BFC5CC" };
const borders = { top: thin, bottom: thin, left: thin, right: thin };
function table(header: string[], rows: string[][], widths: number[]) {
  const cell = (t: string, bold = false, w = 0) => new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ children: [new TextRun({ text: t, font: FONT, size: 20, bold })] })] });
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: header.map((t, i) => cell(t, true, widths[i])) }), ...rows.map((r) => new TableRow({ children: r.map((t, i) => cell(t, false, widths[i])) }))],
  });
}
const docOf = (children: (Paragraph | Table)[]) =>
  new Document({ styles: { default: { document: { run: { font: FONT, size: 22 } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }] });

/** A one-file status report for supervisors or funders, from recorded project data. */
export async function buildStatusReport(d: ProjectData): Promise<Buffer> {
  const W = 9026;
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: d.project.title, font: FONT })] }),
    p(`Status report · ${fmtDate(d.today)}`, { color: MUTED }),
    h("Summary"),
    p(`Overall progress is ${d.project.progressPercent}%. ${d.tasks.done} of ${d.tasks.total} tasks are complete; ${d.tasks.overdue.length} ${d.tasks.overdue.length === 1 ? "is" : "are"} overdue. The library holds ${d.referenceCount} reference${d.referenceCount === 1 ? "" : "s"}.`),
    h("Stages"),
  ];
  const stages = d.stages.filter((s) => s.enabled);
  children.push(stages.length ? table(["Stage", "Status", "Due"], stages.map((s) => [s.name, s.status.replace(/_/g, " "), fmtDate(s.dueDate)]), [4826, 2400, 1800]) : p("No stages yet.", { italics: true }));
  children.push(h("Milestones"));
  children.push(d.milestones.length ? table(["Milestone", "Date", "Status"], d.milestones.map((m) => [m.title, fmtDate(m.date), m.done ? "done" : m.date && m.date < d.today ? "missed" : "upcoming"]), [5226, 2000, 1800]) : p("No milestones scheduled.", { italics: true }));
  children.push(h("Overdue tasks"));
  children.push(d.tasks.overdue.length ? table(["Task", "Due"], d.tasks.overdue.map((t) => [t.title, fmtDate(t.due)]), [W - 2000, 2000]) : p("Nothing is overdue.", { italics: true }));
  children.push(h("Next steps"));
  children.push(d.tasks.upcoming.length ? table(["Task", "Due", "Progress"], d.tasks.upcoming.map((t) => [t.title, fmtDate(t.due), `${t.progress}%`]), [W - 3400, 2000, 1400]) : p("No upcoming tasks.", { italics: true }));
  children.push(h("Open risks"));
  children.push(d.risks.length ? table(["Risk", "L × I", "Mitigation"], d.risks.map((r) => [r.title, `${r.likelihood} × ${r.impact}`, r.mitigation || "—"]), [3400, 1000, W - 4400]) : p("No open risks recorded.", { italics: true }));
  children.push(h("Supervisor reviews"));
  children.push(d.reviews.length ? table(["Round", "Submitted", "Status"], d.reviews.map((r) => [String(r.round), r.createdAt.toISOString().slice(0, 10), r.status.replace(/_/g, " ")]), [1600, 3000, W - 4600]) : p("No reviews requested yet.", { italics: true }));
  return Buffer.from(await Packer.toBuffer(docOf(children)));
}

type Survey = typeof surveys.$inferSelect;

/** Printable questionnaire. */
export async function buildSurveyDocx(s: Survey): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: s.title, font: FONT })] })];
  if (s.introduction) children.push(...s.introduction.split(/\n+/).map((t) => p(t)));
  if (s.consent) children.push(h("Consent", HeadingLevel.HEADING_2), p(s.consent), p("☐ I agree to take part"));
  let section = "";
  s.questions.forEach((q, i) => {
    if (q.section && q.section !== section) {
      section = q.section;
      children.push(h(section, HeadingLevel.HEADING_2));
    }
    children.push(new Paragraph({ spacing: { before: 200, after: 80 }, keepNext: true, children: [new TextRun({ text: `${i + 1}. ${q.text}`, font: FONT, bold: true }), ...(q.required ? [new TextRun({ text: " *", font: FONT, color: "9B2C2C" })] : [])] }));
    if (q.type === "single" || q.type === "multiple") {
      children.push(p(q.type === "multiple" ? "Select all that apply." : "Select one.", { italics: true, color: MUTED, size: 20 }));
      for (const o of q.options ?? []) children.push(new Paragraph({ indent: { left: 360 }, spacing: { after: 40 }, children: [new TextRun({ text: `☐  ${o}`, font: FONT })] }));
    } else if (q.type === "likert") {
      const n = q.scale!.points;
      const w = Math.floor(9026 / n);
      children.push(table(Array.from({ length: n }, (_, k) => String(k + 1)), [Array.from({ length: n }, (_, k) => (k === 0 ? `☐ ${q.scale!.low}` : k === n - 1 ? `☐ ${q.scale!.high}` : "☐"))], Array(n).fill(w)));
    } else {
      const lines = q.type === "number" ? 1 : 3;
      for (let k = 0; k < lines; k++) children.push(new Paragraph({ border: { bottom: thin }, spacing: { after: 240 }, children: [new TextRun(" ")] }));
    }
  });
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 }, children: [new TextRun({ text: "Thank you for your time.", font: FONT, italics: true })] }));
  return Buffer.from(await Packer.toBuffer(docOf(children)));
}

/** Codebook (one row per answer variable) plus a blank data-entry sheet with matching columns. */
export async function buildCodebookXlsx(s: Survey, rows: { variable: string; question: string; type: string; codes: string }[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ResearchMate AI";
  const cb = wb.addWorksheet("Codebook");
  cb.columns = [
    { header: "Variable", key: "variable", width: 18 },
    { header: "Question", key: "question", width: 60 },
    { header: "Type", key: "type", width: 18 },
    { header: "Codes", key: "codes", width: 50 },
  ];
  // Text from users goes in as strings; neutralise anything a spreadsheet would evaluate.
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  for (const r of rows) cb.addRow({ variable: r.variable, question: safe(r.question), type: r.type, codes: safe(r.codes) });
  cb.getRow(1).font = { bold: true };
  cb.views = [{ state: "frozen", ySplit: 1 }];
  cb.getColumn("question").alignment = { wrapText: true, vertical: "top" };
  cb.getColumn("codes").alignment = { wrapText: true, vertical: "top" };
  const entry = wb.addWorksheet("Data entry");
  entry.addRow(["respondent_id", ...rows.map((r) => r.variable)]);
  entry.getRow(1).font = { bold: true };
  entry.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
