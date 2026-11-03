import { budgetAllocations, budgetVersions, financialAuditEvents, fundingTransactions, projectBudgetSettings } from "@researchmate/database";
import { buildReport, convertMinor, FinanceService, formatMoney, invertRate, parseAmount, renderReport, toCsv, toDecimalString } from "@researchmate/finance";
import { PlanningService } from "@researchmate/planning";
import { ProjectMemberService, ProjectService } from "@researchmate/research";
import { addMemberByEmail } from "@researchmate/tenancy";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, fileServices, pdfBuffer, setPlan, streamOf, testDb } from "./helpers";

afterAll(closeTestDb);
const db = () => testDb();
const fin = () => new FinanceService(db());

describe("money", () => {
  it("parses amounts exactly in minor units, respecting currency decimals", () => {
    expect(parseAmount("1,234.50", "KES")).toBe(123450);
    expect(parseAmount("0.1", "USD")).toBe(10);
    expect(parseAmount("5000", "JPY")).toBe(5000);
    expect(() => parseAmount("10.5", "JPY")).toThrow(/at most 0 decimal/);
    expect(() => parseAmount("1.234", "USD")).toThrow(/at most 2/);
    expect(() => parseAmount("-5", "USD")).toThrow();
    expect(parseAmount("-5", "USD", { allowNegative: true })).toBe(-500);
    expect(() => parseAmount("12abc", "USD")).toThrow();
  });

  it("converts with recorded rates using integer arithmetic and half-up rounding", () => {
    expect(convertMinor(10000, "USD", "KES", "129.35")).toBe(1293500); // $100 → KES 12,935.00
    expect(convertMinor(1, "USD", "KES", "0.005")).toBe(0);
    expect(convertMinor(100, "KES", "USD", "0.00775")).toBe(1); // 0.775 cents → 1
    expect(convertMinor(1000, "JPY", "USD", "0.0066")).toBe(660);
    expect(convertMinor(-10000, "USD", "KES", "129.35")).toBe(-1293500);
    expect(invertRate("129.35")).toBe("0.0077309625");
    expect(toDecimalString(123405, "KES")).toBe("1234.05");
    expect(toDecimalString(-5, "USD")).toBe("-0.05");
    expect(formatMoney(123450, "KES")).toMatch(/1,234\.50/);
  });
});

async function setup() {
  const owner = await createUser("Lead");
  await setPlan(owner.orgId, "research_pro");
  const project = await new ProjectService(db()).create(owner.userId, owner.orgId, { title: "Funded fieldwork study", researchType: "masters_thesis", workflowTemplateKey: "" });
  await fin().configure(owner.userId, project.id, { enabled: true, baseCurrency: "KES" });
  return { owner, project };
}

async function member(owner: { userId: string; orgId: string }, projectId: string, orgRole: string, projectRole?: string) {
  const u = await createUser(orgRole);
  await addMemberByEmail(db(), owner.userId, owner.orgId, u.email, orgRole);
  if (projectRole) await new ProjectMemberService(db()).add(owner.userId, projectId, u.userId, projectRole);
  return u;
}

describe("finance: enablement, permissions and entitlement", () => {
  it("is optional per project and requires the budget entitlement", async () => {
    const free = await createUser();
    const p = await new ProjectService(db()).create(free.userId, free.orgId, { title: "Unfunded study", researchType: "custom", workflowTemplateKey: "" });
    await expect(fin().configure(free.userId, p.id, { enabled: true, baseCurrency: "KES" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    const s = await fin().getSettings(free.userId, p.id);
    expect(s.settings).toBeNull();
    await expect(fin().dashboard(free.userId, p.id)).rejects.toThrow(/not enabled/);

    const { owner, project } = await setup();
    await fin().configure(owner.userId, project.id, { enabled: false });
    await expect(fin().createExpense(owner.userId, project.id, { description: "x", categoryKey: "travel", expenseDate: "2026-03-01", amount: "10" })).rejects.toThrow(/not enabled/);
    await fin().configure(owner.userId, project.id, { enabled: true });
    expect((await db().select().from(projectBudgetSettings).where(eq(projectBudgetSettings.projectId, project.id)))[0]!.baseCurrency).toBe("KES");
  });

  it("separates financial permissions from research permissions", async () => {
    const { owner, project } = await setup();
    const researcher = await member(owner, project.id, "org_member", "project_researcher");
    const financeMgr = await member(owner, project.id, "org_finance_manager");
    await expect(fin().dashboard(researcher.userId, project.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const e = await fin().createExpense(financeMgr.userId, project.id, { description: "Bus fares", categoryKey: "travel", expenseDate: "2026-03-02", amount: "2400", submit: true });
    expect(e.status).toBe("submitted");
    // The finance manager can't edit research.
    await expect(new PlanningService(db()).createTask(financeMgr.userId, project.id, { title: "x", startDate: "2026-03-01" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Organization admins see research but not money.
    const admin = await member(owner, project.id, "org_admin");
    await expect(fin().listExpenses(admin.userId, project.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Other tenants see nothing.
    const outsider = await createUser();
    await expect(fin().dashboard(outsider.userId, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("finance: budgets", () => {
  it("versions budgets; approved versions are frozen and kept when revised", async () => {
    const { owner, project } = await setup();
    const v1 = await fin().draft(owner.userId, project.id);
    await fin().setAllocation(owner.userId, v1.id, { categoryKey: "fieldwork", amount: "150000" });
    await fin().setAllocation(owner.userId, v1.id, { categoryKey: "transcription", amount: "100000" });
    await expect(fin().setAllocation(owner.userId, v1.id, { categoryKey: "made_up", amount: "1" })).rejects.toThrow(/valid category/);
    await fin().approveBudget(owner.userId, v1.id);
    let budgets = await fin().listBudgets(owner.userId, project.id);
    expect(budgets[0]).toMatchObject({ status: "approved", totalBaseMinor: 25_000_000 });
    await expect(fin().setAllocation(owner.userId, v1.id, { categoryKey: "fieldwork", amount: "1" })).rejects.toMatchObject({ code: "READ_ONLY" });

    // The database refuses changes too.
    await expect(db().update(budgetVersions).set({ totalBaseMinor: 1 }).where(eq(budgetVersions.id, v1.id))).rejects.toThrow();
    await expect(db().update(budgetAllocations).set({ amountBaseMinor: 1 }).where(eq(budgetAllocations.versionId, v1.id))).rejects.toThrow();
    await expect(db().delete(budgetVersions).where(eq(budgetVersions.id, v1.id))).rejects.toThrow();

    // Revision starts from the approved lines; approving it supersedes v1.
    const v2 = await fin().draft(owner.userId, project.id);
    expect(v2.number).toBe(2);
    await fin().setAllocation(owner.userId, v2.id, { categoryKey: "fieldwork", amount: "200000" });
    await fin().approveBudget(owner.userId, v2.id);
    budgets = await fin().listBudgets(owner.userId, project.id);
    expect(budgets.map((b) => [b.number, b.status, b.totalBaseMinor])).toEqual([
      [2, "approved", 30_000_000],
      [1, "superseded", 25_000_000],
    ]);
    expect(budgets[1]!.lines.find((l) => l.categoryKey === "fieldwork")!.amountBaseMinor).toBe(15_000_000);
  });

  it("only approvers approve budgets", async () => {
    const { owner, project } = await setup();
    const financeMember = await member(owner, project.id, "org_member", "project_finance_manager");
    const d = await fin().draft(financeMember.userId, project.id);
    const viewer = await member(owner, project.id, "org_member", "project_viewer");
    await expect(fin().approveBudget(viewer.userId, d.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await fin().approveBudget(financeMember.userId, d.id);
  });
});

describe("finance: expenses, currency and no double counting", () => {
  it("runs the approval workflow and counts each expense in exactly one bucket", async () => {
    const { owner, project } = await setup();
    const approver = await member(owner, project.id, "org_finance_manager");
    const v = await fin().draft(owner.userId, project.id);
    await fin().setAllocation(owner.userId, v.id, { categoryKey: "travel", amount: "250000" });
    await fin().approveBudget(owner.userId, v.id);

    const mk = (amount: string, submit = true) => fin().createExpense(owner.userId, project.id, { description: `Expense ${amount}`, categoryKey: "travel", expenseDate: "2026-03-05", amount, submit });
    const a = await mk("40000"); // → approved (committed)
    const b = await mk("65000"); // → paid (actual)
    await mk("15000"); // stays submitted (pending)
    const draft = await mk("99999", false); // draft: not counted
    const rej = await mk("5000"); // rejected: not counted

    await fin().transitionExpense(approver.userId, a.id, "approve");
    await fin().transitionExpense(approver.userId, b.id, "approve");
    await fin().transitionExpense(owner.userId, b.id, "pay", { paidAt: "2026-03-07" });
    await expect(fin().transitionExpense(approver.userId, rej.id, "reject")).rejects.toThrow(/reason/);
    await fin().transitionExpense(approver.userId, rej.id, "reject", { note: "Duplicate" });
    await expect(fin().transitionExpense(owner.userId, draft.id, "pay")).rejects.toThrow(/can't be marked paid/);
    await expect(fin().updateExpense(owner.userId, b.id, { description: "edited", categoryKey: "travel", expenseDate: "2026-03-05", amount: "1" })).rejects.toMatchObject({ code: "READ_ONLY" });

    const d = await fin().dashboard(owner.userId, project.id);
    expect(d).toMatchObject({ budget: 25_000_000, committed: 4_000_000, actual: 6_500_000, pending: 1_500_000, remaining: 14_500_000, utilisationPercent: 42 });

    // Paying a committed expense moves it from committed to actual, never both.
    await fin().transitionExpense(owner.userId, a.id, "pay");
    const d2 = await fin().dashboard(owner.userId, project.id);
    expect(d2.committed + d2.actual).toBe(d.committed + d.actual);
    expect(d2).toMatchObject({ committed: 0, actual: 10_500_000 });

    // Self-approval is allowed but recorded.
    const self = await mk("1000");
    expect((await fin().transitionExpense(owner.userId, self.id, "approve")).selfApproved).toBe(true);
    const audit = await db().select().from(financialAuditEvents).where(eq(financialAuditEvents.projectId, project.id));
    expect(audit.length).toBeGreaterThan(10);
    await expect(db().update(financialAuditEvents).set({ action: "tampered" }).where(eq(financialAuditEvents.projectId, project.id))).rejects.toThrow();
  });

  it("stores the original currency, rate and date, and never re-converts history", async () => {
    const { owner, project } = await setup();
    await expect(fin().createExpense(owner.userId, project.id, { description: "Licence", categoryKey: "software", expenseDate: "2026-03-01", amount: "100", currency: "USD" })).rejects.toThrow(/No USD→KES exchange rate/);
    await fin().addRate(owner.userId, project.id, { fromCurrency: "USD", toCurrency: "KES", rate: "129.35", rateDate: "2026-02-28" });
    const e = await fin().createExpense(owner.userId, project.id, { description: "Licence", categoryKey: "software", expenseDate: "2026-03-01", amount: "100", currency: "USD" });
    expect(e).toMatchObject({ amountMinor: 10000, currency: "USD", fxDate: "2026-02-28", baseAmountMinor: 1293500 });
    expect(String(e.fxRate)).toMatch(/^129\.35/);

    // A newer rate does not touch the recorded expense.
    await fin().addRate(owner.userId, project.id, { fromCurrency: "USD", toCurrency: "KES", rate: "140", rateDate: "2026-03-10" });
    const [again] = (await fin().listExpenses(owner.userId, project.id)).map((r) => r.e);
    expect(again!.baseAmountMinor).toBe(1293500);

    // Inverse stored rate and explicit rate.
    await fin().addRate(owner.userId, project.id, { fromCurrency: "KES", toCurrency: "EUR", rate: "0.0071", rateDate: "2026-03-01" });
    const eur = await fin().createExpense(owner.userId, project.id, { description: "Conference", categoryKey: "conference_fees", expenseDate: "2026-03-02", amount: "50", currency: "EUR" });
    expect(eur.baseAmountMinor).toBe(704225); // 50 EUR ÷ 0.0071 ≈ KES 7,042.25
    const explicit = await fin().createExpense(owner.userId, project.id, { description: "Book", categoryKey: "materials", expenseDate: "2026-03-02", amount: "10", currency: "GBP", fxRate: "165.2" });
    expect(explicit.baseAmountMinor).toBe(165200);

    // Base currency is locked once money is recorded.
    await expect(fin().configure(owner.userId, project.id, { enabled: true, baseCurrency: "USD" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reconciles funding, receipts and spending per source", async () => {
    const { owner, project } = await setup();
    await fin().addRate(owner.userId, project.id, { fromCurrency: "USD", toCurrency: "KES", rate: "130", rateDate: "2026-01-01" });
    const grant = await fin().createFundingSource(owner.userId, project.id, { name: "NRF small grant", kind: "grant", currency: "USD", awarded: "5000", reference: "NRF/2026/01" });
    await fin().recordReceipt(owner.userId, grant.id, { receivedDate: "2026-02-01", amount: "3000" });
    await expect(fin().recordReceipt(owner.userId, grant.id, { receivedDate: "2026-02-02", amount: "-100" })).rejects.toThrow(/Explain/);
    await fin().recordReceipt(owner.userId, grant.id, { receivedDate: "2026-02-02", amount: "-500", note: "Bank reversal" });
    await expect(db().update(fundingTransactions).set({ note: "x" }).where(eq(fundingTransactions.fundingSourceId, grant.id))).rejects.toThrow();
    const e = await fin().createExpense(owner.userId, project.id, { description: "Enumerators", categoryKey: "research_assistants", expenseDate: "2026-02-10", amount: "60000", fundingSourceId: grant.id, submit: true });
    await fin().transitionExpense(owner.userId, e.id, "approve");
    const d = await fin().dashboard(owner.userId, project.id);
    expect(d.receivedBase).toBe(32_500_000);
    expect(d.funding[0]).toMatchObject({ receivedOrig: 250000, outstandingOrig: 250000, receivedBase: 32_500_000, spentBase: 6_000_000 });

    // Expenses cannot point at another project's funding.
    const other = await setup();
    await expect(fin().createExpense(other.owner.userId, other.project.id, { description: "x", categoryKey: "travel", expenseDate: "2026-02-10", amount: "1", fundingSourceId: grant.id })).rejects.toThrow(/another project/);
  });

  it("links task cost estimates to the schedule without changing the approved budget", async () => {
    const { owner, project } = await setup();
    const planning = new PlanningService(db());
    const field = (await planning.createTask(owner.userId, project.id, { title: "Fieldwork", startDate: "2026-04-01", endDate: "2026-04-30" })).task;
    const v = await fin().draft(owner.userId, project.id);
    await fin().setAllocation(owner.userId, v.id, { categoryKey: "fieldwork", amount: "100000" });
    await fin().approveBudget(owner.userId, v.id);
    await fin().setEstimate(owner.userId, field.id, { categoryKey: "fieldwork", amount: "80000" });
    await fin().setEstimate(owner.userId, field.id, { categoryKey: "accommodation", amount: "30000" });
    const spent = await fin().createExpense(owner.userId, project.id, { description: "Transport", categoryKey: "fieldwork", expenseDate: "2026-04-03", amount: "20000", taskId: field.id, submit: true });
    await fin().transitionExpense(owner.userId, spent.id, "approve");
    let d = await fin().dashboard(owner.userId, project.id);
    expect(d.outstandingEstimates).toBe(9_000_000); // 110k estimate − 20k spent
    expect(d.forecast).toBe(2_000_000 + 9_000_000);
    expect(d.budget).toBe(10_000_000);

    // Rescheduling the task changes nothing financial; finishing it drops its outstanding estimate.
    await planning.updateTask(owner.userId, field.id, { startDate: "2026-05-01", endDate: "2026-05-30" });
    d = await fin().dashboard(owner.userId, project.id);
    expect(d.budget).toBe(10_000_000);
    await planning.updateTask(owner.userId, field.id, { status: "done" });
    d = await fin().dashboard(owner.userId, project.id);
    expect(d.outstandingEstimates).toBe(0);
    expect(d.categories.find((c) => c.key === "fieldwork")).toMatchObject({ budget: 10_000_000, estimated: 8_000_000, committed: 2_000_000 });
  });

  it("attaches receipts from the project's files only", async () => {
    const { owner, project } = await setup();
    const e = await fin().createExpense(owner.userId, project.id, { description: "Printing", categoryKey: "printing", expenseDate: "2026-03-01", amount: "1200" });
    const { files } = fileServices();
    const buf = pdfBuffer(2000);
    const f = await files.upload({ actorUserId: owner.userId, organizationId: owner.orgId, projectId: project.id, filename: "receipt.pdf", declaredSize: buf.length, body: streamOf(buf) });
    await fin().attachReceipt(owner.userId, e.id, f.id);
    const other = await setup();
    const g = await files.upload({ actorUserId: other.owner.userId, organizationId: other.owner.orgId, projectId: other.project.id, filename: "x.pdf", declaredSize: buf.length, body: streamOf(buf) });
    await expect(fin().attachReceipt(owner.userId, e.id, g.id)).rejects.toThrow(/from this project/);
    expect((await fin().listExpenses(owner.userId, project.id))[0]!.attachments.map((a) => a.name)).toEqual(["receipt.pdf"]);
  });
});

describe("finance: reports", () => {
  it("exports every report as CSV, XLSX and PDF", async () => {
    const { owner, project } = await setup();
    const v = await fin().draft(owner.userId, project.id);
    await fin().setAllocation(owner.userId, v.id, { categoryKey: "travel", amount: "1000" });
    await fin().approveBudget(owner.userId, v.id);
    const e = await fin().createExpense(owner.userId, project.id, { description: "=HYPERLINK(\"http://evil\")", categoryKey: "travel", expenseDate: "2026-03-01", amount: "250.50", submit: true });
    await fin().transitionExpense(owner.userId, e.id, "approve");

    const summary = await buildReport(fin(), owner.userId, project.id, "budget_summary");
    expect(summary.rows.at(-1)).toEqual(["Total", 100000, 25050, 0, 0, 74950, "25.1%"]);
    const csv = toCsv(await buildReport(fin(), owner.userId, project.id, "expenses"));
    expect(csv).toContain("'=HYPERLINK"); // formula neutralised
    expect(csv).toContain("250.50");

    for (const key of ["budget_summary", "expenses", "category", "planned_vs_actual", "funding", "monthly", "grant"] as const) {
      const t = await buildReport(fin(), owner.userId, project.id, key);
      const pdf = await renderReport(t, "pdf");
      expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
      const x = await renderReport(t, "xlsx");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.body as never);
      expect(wb.getWorksheet("Report")!.getRow(4).getCell(1).value).toBe(t.columns[0]!.header);
    }
  });
});
