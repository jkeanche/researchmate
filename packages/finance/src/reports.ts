import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { formatMoney, toDecimalString } from "./money";
import { BUCKET, type ExpenseStatus, type FinanceService } from "./service";

export const REPORTS = {
  budget_summary: "Project budget summary",
  expenses: "Expense report",
  category: "Category expenditure",
  planned_vs_actual: "Planned versus actual",
  funding: "Funding utilisation",
  monthly: "Monthly spending",
  grant: "Grant expenditure",
} as const;
export type ReportKey = keyof typeof REPORTS;
export type ReportFormat = "csv" | "xlsx" | "pdf";

type Cell = string | number | null;
interface Column {
  header: string;
  /** money columns hold minor units of `currency` (or the row's own currency key). */
  money?: boolean;
  currencyFrom?: string;
}
export interface ReportTable {
  title: string;
  subtitle: string;
  base: string;
  columns: Column[];
  rows: Cell[][];
  /** Per-row currency for money columns that are not in the base currency. */
  rowCurrency?: (string | null)[];
  notes: string[];
}

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

export async function buildReport(svc: FinanceService, actorUserId: string, projectId: string, key: ReportKey, generatedAt = new Date()): Promise<ReportTable> {
  const d = await svc.dashboard(actorUserId, projectId);
  const title = `${REPORTS[key]}: ${await svc.projectTitle(projectId)}`;
  const subtitle = `Base currency ${d.base} · ${d.approved ? `approved budget v${d.approved.number} (${d.approved.name})` : "no approved budget"} · generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const notes = [
    "Pending = submitted, awaiting approval. Committed = approved, not yet paid. Actual = paid or reimbursed. Each expense is counted in exactly one of these.",
    "Foreign-currency amounts are converted at the rate recorded with each transaction; historical amounts are never re-converted.",
    "Project financial management only; not a substitute for statutory accounting.",
  ];
  const base = d.base;
  const M = (h: string): Column => ({ header: `${h} (${base})`, money: true });

  switch (key) {
    case "budget_summary":
    case "category": {
      const rows = d.categories.map((c) =>
        key === "budget_summary"
          ? [c.name, c.budget, c.committed, c.actual, c.pending, c.budget - c.committed - c.actual, pct(c.committed + c.actual, c.budget)]
          : [c.name, c.actual, c.committed, pct(c.actual, d.actual)],
      );
      if (key === "budget_summary") rows.push(["Total", d.budget, d.committed, d.actual, d.pending, d.remaining, pct(d.committed + d.actual, d.budget)]);
      else rows.push(["Total", d.actual, d.committed, "100%"]);
      return {
        title,
        subtitle,
        base,
        columns: key === "budget_summary" ? [{ header: "Category" }, M("Budget"), M("Committed"), M("Actual"), M("Pending"), M("Remaining"), { header: "Utilisation" }] : [{ header: "Category" }, M("Actual"), M("Committed"), { header: "Share of actual" }],
        rows,
        notes,
      };
    }
    case "planned_vs_actual": {
      const rows: Cell[][] = d.categories.map((c) => [c.name, c.budget, c.estimated, c.committed + c.actual, c.budget - (c.committed + c.actual)]);
      rows.push(["Total", d.budget, d.categories.reduce((a, c) => a + c.estimated, 0), d.committed + d.actual, d.budget - d.committed - d.actual]);
      return {
        title,
        subtitle,
        base,
        columns: [{ header: "Category" }, M("Budget"), M("Task estimates"), M("Committed + actual"), M("Variance")],
        rows,
        notes: [...notes, `Forecast completion cost: ${formatMoney(d.forecast, base)} (spending to date plus outstanding task estimates). Task estimates are estimates, not spending.`],
      };
    }
    case "funding":
    case "grant": {
      const list = key === "grant" ? d.funding.filter((f) => f.source.kind === "grant") : d.funding;
      return {
        title,
        subtitle,
        base,
        columns: [{ header: "Source" }, { header: "Type" }, { header: "Reference" }, { header: "Awarded", money: true, currencyFrom: "row" }, { header: "Received", money: true, currencyFrom: "row" }, { header: "Outstanding", money: true, currencyFrom: "row" }, M("Received"), M("Committed + spent")],
        rows: list.map((f) => [f.source.name, f.source.kind, f.source.reference, f.source.awardedMinor, f.receivedOrig, f.outstandingOrig, f.receivedBase, f.spentBase]),
        rowCurrency: list.map((f) => f.source.currency),
        notes,
      };
    }
    case "monthly": {
      return {
        title,
        subtitle,
        base,
        columns: [{ header: "Month" }, M("Actual"), M("Committed"), M("Total")],
        rows: d.monthly.map((m) => [m.month, m.actual, m.committed, m.actual + m.committed]),
        notes,
      };
    }
    case "expenses": {
      const list = await svc.listExpenses(actorUserId, projectId);
      return {
        title,
        subtitle,
        base,
        columns: [
          { header: "Date" },
          { header: "Description" },
          { header: "Category" },
          { header: "Vendor" },
          { header: "Task" },
          { header: "Status" },
          { header: "Counts as" },
          { header: "Amount", money: true, currencyFrom: "row" },
          { header: "Currency" },
          { header: "Rate" },
          M("Amount"),
          { header: "Submitted by" },
          { header: "Self-approved" },
        ],
        rows: list.map(({ e, taskTitle, submitter, history }) => [
          e.expenseDate,
          e.description,
          d.categories.find((c) => c.key === e.categoryKey)?.name ?? e.categoryKey,
          e.vendor,
          taskTitle ?? "",
          e.status,
          BUCKET[e.status as ExpenseStatus] ?? "not counted",
          e.amountMinor,
          e.currency,
          String(e.fxRate),
          e.baseAmountMinor,
          submitter ?? "",
          history.some((h) => h.h.selfApproved) ? "yes" : "",
        ]),
        rowCurrency: list.map(({ e }) => e.currency),
        notes,
      };
    }
  }
}

function cellText(t: ReportTable, r: number, c: number, display: boolean): string {
  const v = t.rows[r]![c];
  const col = t.columns[c]!;
  if (v === null || v === undefined) return "";
  if (col.money && typeof v === "number") {
    const cur = col.currencyFrom === "row" ? (t.rowCurrency?.[r] ?? t.base) : t.base;
    return display ? formatMoney(v, cur) : toDecimalString(v, cur);
  }
  return String(v);
}

/** RFC 4180 CSV; cells that spreadsheets would treat as formulas are neutralised. */
export function toCsv(t: ReportTable): string {
  const esc = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [t.columns.map((c) => esc(c.header)).join(",")];
  for (let r = 0; r < t.rows.length; r++) lines.push(t.columns.map((_, c) => esc(cellText(t, r, c, false))).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export async function toXlsx(t: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ResearchMate AI";
  const ws = wb.addWorksheet("Report");
  ws.addRow([t.title]).font = { bold: true, size: 14 };
  ws.addRow([t.subtitle]).font = { italic: true, color: { argb: "FF56636F" } };
  ws.addRow([]);
  const head = ws.addRow(t.columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((cell) => (cell.border = { bottom: { style: "thin" } }));
  for (let r = 0; r < t.rows.length; r++) {
    const row = ws.addRow(
      t.columns.map((col, c) => {
        const v = t.rows[r]![c];
        if (col.money && typeof v === "number") return Number(toDecimalString(v, col.currencyFrom === "row" ? (t.rowCurrency?.[r] ?? t.base) : t.base));
        return v ?? "";
      }),
    );
    t.columns.forEach((col, c) => {
      if (col.money) row.getCell(c + 1).numFmt = "#,##0.00";
    });
    if (String(t.rows[r]![0]) === "Total") row.font = { bold: true };
  }
  ws.addRow([]);
  for (const n of t.notes) ws.addRow([n]).font = { size: 9, color: { argb: "FF56636F" } };
  ws.columns.forEach((col, i) => (col.width = Math.min(48, Math.max(12, ...[t.columns[i]?.header ?? "", ...t.rows.map((_, r) => cellText(t, r, i, true))].map((s) => s.length + 2)))));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(t: ReportTable): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: t.columns.length > 6 ? "landscape" : "portrait", margin: 36, info: { Title: t.title, Creator: "ResearchMate AI" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const width = doc.page.width - 72;
  doc.font("Helvetica-Bold").fontSize(14).text(t.title);
  doc.font("Helvetica").fontSize(8.5).fillColor("#56636f").text(t.subtitle).moveDown(0.8).fillColor("#1b2a3a");
  const weights = t.columns.map((c, i) => (c.money ? 1.1 : i === 0 || c.header === "Description" ? 1.8 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * width);
  const drawRow = (cells: string[], bold: boolean) => {
    const size = t.columns.length > 9 ? 6.5 : 8;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    const h = Math.max(...cells.map((s, i) => doc.heightOfString(s, { width: widths[i]! - 4 }))) + 4;
    if (doc.y + h > doc.page.height - 48) doc.addPage();
    const y = doc.y;
    let x = 36;
    cells.forEach((s, i) => {
      doc.text(s, x + 2, y + 2, { width: widths[i]! - 4, align: t.columns[i]!.money ? "right" : "left" });
      x += widths[i]!;
    });
    doc.y = y + h;
    doc.moveTo(36, doc.y).lineTo(36 + width, doc.y).lineWidth(0.3).strokeColor("#cad6e2").stroke();
  };
  drawRow(t.columns.map((c) => c.header), true);
  for (let r = 0; r < t.rows.length; r++) drawRow(t.columns.map((_, c) => cellText(t, r, c, true)), String(t.rows[r]![0]) === "Total");
  if (!t.rows.length) doc.font("Helvetica").fontSize(9).text("No data yet.", 36, doc.y + 6);
  doc.moveDown(1).font("Helvetica").fontSize(7.5).fillColor("#56636f");
  for (const n of t.notes) doc.text(n, 36, undefined, { width });
  doc.end();
  return done;
}

export async function renderReport(t: ReportTable, format: ReportFormat): Promise<{ body: Buffer; contentType: string; extension: string }> {
  if (format === "csv") return { body: Buffer.from(toCsv(t), "utf8"), contentType: "text/csv; charset=utf-8", extension: "csv" };
  if (format === "xlsx") return { body: await toXlsx(t), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
  return { body: await toPdf(t), contentType: "application/pdf", extension: "pdf" };
}
