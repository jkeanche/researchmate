import {
  budgetAllocations,
  budgetCategories,
  budgetVersions,
  type Database,
  type DbOrTx,
  exchangeRates,
  EXPENSE_STATUSES,
  expenseApprovals,
  expenseAttachments,
  files,
  financialAuditEvents,
  FUNDING_KINDS,
  fundingSources,
  fundingTransactions,
  PAYMENT_METHODS,
  projectBudgetSettings,
  projectExpenses,
  researchProjects,
  researchTasks,
  taskCostEstimates,
  userProfiles,
} from "@researchmate/database";
import { getEntitlements } from "@researchmate/entitlements";
import { assertProjectWritable } from "@researchmate/research";
import { AppError } from "@researchmate/shared";
import { getProjectAccess, notify, projectRecipients, type ProjectAccess } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { convertMinor, formatMoney, invertRate, isCurrency, isRate, parseAmount } from "./money";

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");
const optUuid = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), "Invalid id");

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]!.message);
  return r.data;
}

function amount(input: unknown, currency: string, allowNegative = false): number {
  try {
    const v = parseAmount(String(input ?? ""), currency, { allowNegative });
    if (!allowNegative && v <= 0) throw new Error("Enter an amount greater than zero.");
    return v;
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }
}

function nonNegative(input: unknown, currency: string): number {
  if (String(input ?? "").trim() === "" || String(input).trim() === "0") return 0;
  return amount(input, currency);
}

type Perm = "finance.read" | "finance.manage" | "finance.approve";

export class FinanceService {
  constructor(private readonly db: Database) {}

  // ----- Access ------------------------------------------------------------

  private async guard(actorUserId: string, projectId: string, perm: Perm, opts: { write?: boolean; requireEnabled?: boolean } = {}) {
    let access: ProjectAccess;
    access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has(perm)) throw new AppError("FORBIDDEN", perm === "finance.read" ? "You do not have access to this project's finances." : "You do not have permission to change this project's finances.");
    if (opts.write) {
      await assertProjectWritable(this.db, projectId);
      const ent = await getEntitlements(this.db, access.organizationId);
      if (ent.values["finance.budget"] !== true) throw new AppError("FEATURE_NOT_ENTITLED", `Budget management is not included in the ${ent.planName} plan.`, { feature: "finance.budget" });
    }
    const [settings] = await this.db.select().from(projectBudgetSettings).where(eq(projectBudgetSettings.projectId, projectId));
    if ((opts.requireEnabled ?? true) && !settings?.enabled) throw new AppError("VALIDATION", "Financial tracking is not enabled for this project.");
    return { access, settings: settings ?? null, base: settings?.baseCurrency ?? "USD" };
  }

  private async audit(tx: DbOrTx, projectId: string, actorUserId: string, action: string, entityType: string, entityId: string | null, before: unknown, after: unknown) {
    await tx.insert(financialAuditEvents).values({ projectId, actorUserId, action, entityType, entityId, before: (before ?? null) as never, after: (after ?? null) as never });
  }

  // ----- Settings ----------------------------------------------------------

  async getSettings(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const [settings] = await this.db.select().from(projectBudgetSettings).where(eq(projectBudgetSettings.projectId, projectId));
    const ent = await getEntitlements(this.db, access.organizationId);
    return { access, settings: settings ?? null, entitled: ent.values["finance.budget"] === true, planName: ent.planName, canRead: access.permissions.has("finance.read") };
  }

  /** Turns financial tracking on or off for one project. Turning it off hides but keeps all records. */
  async configure(actorUserId: string, projectId: string, input: { enabled: boolean; baseCurrency?: string; alertThresholdPercent?: number | string; notes?: string }) {
    const { access, settings } = await this.guard(actorUserId, projectId, "finance.manage", { write: input.enabled, requireEnabled: false });
    if (!input.enabled && !settings) return;
    const base = (input.baseCurrency ?? settings?.baseCurrency ?? "").toUpperCase();
    if (!isCurrency(base)) throw new AppError("VALIDATION", "Choose a valid currency (e.g. KES, USD).");
    const threshold = Number(input.alertThresholdPercent ?? settings?.alertThresholdPercent ?? 80);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new AppError("VALIDATION", "The alert threshold must be between 1 and 100%.");
    if (settings && settings.baseCurrency !== base) {
      const [[e], [v]] = await Promise.all([
        this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(projectExpenses).where(eq(projectExpenses.projectId, projectId)),
        this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(budgetVersions).where(eq(budgetVersions.projectId, projectId)),
      ]);
      if ((e?.n ?? 0) + (v?.n ?? 0) > 0) throw new AppError("CONFLICT", "The base currency can't change once budgets or expenses exist; historical amounts are never re-converted.");
    }
    const row = { projectId, enabled: input.enabled, baseCurrency: base, alertThresholdPercent: threshold, notes: (input.notes ?? settings?.notes ?? "").slice(0, 2000), updatedByUserId: actorUserId, updatedAt: new Date() };
    await this.db.transaction(async (tx) => {
      await tx.insert(projectBudgetSettings).values(row).onConflictDoUpdate({ target: projectBudgetSettings.projectId, set: row });
      await this.audit(tx, projectId, actorUserId, input.enabled ? "finance.enabled" : "finance.disabled", "settings", null, settings, row);
    });
    void access;
  }

  // ----- Categories and rates ---------------------------------------------

  async categories(organizationId: string) {
    return this.db
      .select()
      .from(budgetCategories)
      .where(and(eq(budgetCategories.archived, false), or(isNull(budgetCategories.organizationId), eq(budgetCategories.organizationId, organizationId))))
      .orderBy(asc(budgetCategories.sortOrder), asc(budgetCategories.name));
  }

  async addCategory(actorUserId: string, projectId: string, name: string) {
    const { access } = await this.guard(actorUserId, projectId, "finance.manage", { write: true });
    const n = name.trim();
    if (n.length < 2 || n.length > 100) throw new AppError("VALIDATION", "Category names need 2–100 characters.");
    const key = `custom_${n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}`;
    const existing = await this.categories(access.organizationId);
    if (existing.some((c) => c.key === key || c.name.toLowerCase() === n.toLowerCase())) throw new AppError("CONFLICT", "That category already exists.");
    const [row] = await this.db.insert(budgetCategories).values({ organizationId: access.organizationId, key, name: n, sortOrder: 1000 }).returning();
    return row!;
  }

  private async assertCategory(organizationId: string, key: string) {
    if (!(await this.categories(organizationId)).some((c) => c.key === key)) throw new AppError("VALIDATION", "Choose a valid category.");
  }

  async addRate(actorUserId: string, projectId: string, input: { fromCurrency: string; toCurrency: string; rate: string; rateDate: string }) {
    const { access } = await this.guard(actorUserId, projectId, "finance.manage", { write: true });
    const from = input.fromCurrency.toUpperCase();
    const to = input.toCurrency.toUpperCase();
    if (!isCurrency(from) || !isCurrency(to) || from === to) throw new AppError("VALIDATION", "Choose two different valid currencies.");
    if (!isRate(input.rate)) throw new AppError("VALIDATION", "Enter a positive rate with up to 10 decimal places.");
    parse(iso, input.rateDate);
    await this.db
      .insert(exchangeRates)
      .values({ organizationId: access.organizationId, fromCurrency: from, toCurrency: to, rate: input.rate.trim(), rateDate: input.rateDate, createdByUserId: actorUserId })
      .onConflictDoUpdate({ target: [exchangeRates.organizationId, exchangeRates.fromCurrency, exchangeRates.toCurrency, exchangeRates.rateDate], set: { rate: input.rate.trim(), createdByUserId: actorUserId } });
  }

  async listRates(organizationId: string) {
    return this.db.select().from(exchangeRates).where(eq(exchangeRates.organizationId, organizationId)).orderBy(desc(exchangeRates.rateDate)).limit(100);
  }

  /**
   * The rate to record with a foreign-currency amount: an explicitly entered
   * rate, else the latest stored rate on or before the date (either
   * direction). Never fetched from the internet and never guessed.
   */
  async resolveRate(organizationId: string, from: string, to: string, onDate: string, explicit?: string | null): Promise<{ rate: string; fxDate: string }> {
    if (from === to) return { rate: "1", fxDate: onDate };
    if (explicit && explicit.trim()) {
      if (!isRate(explicit)) throw new AppError("VALIDATION", "Enter a positive exchange rate with up to 10 decimal places.");
      return { rate: explicit.trim(), fxDate: onDate };
    }
    const find = (a: string, b: string) =>
      this.db
        .select()
        .from(exchangeRates)
        .where(and(eq(exchangeRates.organizationId, organizationId), eq(exchangeRates.fromCurrency, a), eq(exchangeRates.toCurrency, b), lte(exchangeRates.rateDate, onDate)))
        .orderBy(desc(exchangeRates.rateDate))
        .limit(1);
    const [direct] = await find(from, to);
    if (direct) return { rate: String(direct.rate), fxDate: direct.rateDate };
    const [inverse] = await find(to, from);
    if (inverse) return { rate: invertRate(String(inverse.rate)), fxDate: inverse.rateDate };
    throw new AppError("VALIDATION", `No ${from}→${to} exchange rate is recorded on or before ${onDate}. Enter the rate used.`);
  }

  // ----- Funding -----------------------------------------------------------

  async listFunding(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, "finance.read", { requireEnabled: false });
    const [sources, receipts] = await Promise.all([
      this.db.select().from(fundingSources).where(eq(fundingSources.projectId, projectId)).orderBy(asc(fundingSources.createdAt)),
      this.db.select().from(fundingTransactions).where(eq(fundingTransactions.projectId, projectId)).orderBy(desc(fundingTransactions.receivedDate), desc(fundingTransactions.createdAt)),
    ]);
    return { sources, receipts };
  }

  async createFundingSource(actorUserId: string, projectId: string, input: Record<string, unknown>) {
    const { base } = await this.guard(actorUserId, projectId, "finance.manage", { write: true });
    const cur = String(input.currency || base).toUpperCase();
    if (!isCurrency(cur)) throw new AppError("VALIDATION", "Choose a valid currency.");
    const d = parse(
      z.object({
        name: z.string().trim().min(1, "Name the funding source").max(200),
        kind: z.enum(FUNDING_KINDS),
        funderName: z.string().trim().max(200).default(""),
        reference: z.string().trim().max(200).default(""),
        startDate: iso.nullable().optional().or(z.literal("").transform(() => null)),
        endDate: iso.nullable().optional().or(z.literal("").transform(() => null)),
        reportingPeriod: z.string().trim().max(100).default(""),
        notes: z.string().trim().max(2000).default(""),
      }),
      input,
    );
    if (d.startDate && d.endDate && d.endDate < d.startDate) throw new AppError("VALIDATION", "The end date must be after the start date.");
    const awarded = nonNegative(input.awarded, cur);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(fundingSources).values({ ...d, currency: cur, awardedMinor: awarded, projectId, createdByUserId: actorUserId }).returning();
      await this.audit(tx, projectId, actorUserId, "funding.source.created", "funding_source", row!.id, null, row);
      return row!;
    }).then(async (row) => {
      await notify(this.db, { userIds: await projectRecipients(this.db, projectId, "finance.read", [actorUserId]), kind: "finance.funding", title: `Funding source added: ${row.name}`, body: `${row.name}${row.funderName ? ` (${row.funderName})` : ""} was added to “${await this.projectTitle(projectId)}”.`, link: `/app/projects/${projectId}/finance`, projectId });
      return row;
    });
  }

  async recordReceipt(actorUserId: string, sourceId: string, input: { receivedDate: string; amount: string; fxRate?: string; note?: string }) {
    const [src] = await this.db.select().from(fundingSources).where(eq(fundingSources.id, sourceId));
    if (!src) throw new AppError("NOT_FOUND", "Funding source not found.");
    const { access, base } = await this.guard(actorUserId, src.projectId, "finance.manage", { write: true });
    parse(iso, input.receivedDate);
    const amt = amount(input.amount, src.currency, true);
    if (amt === 0) throw new AppError("VALIDATION", "Enter a non-zero amount.");
    if (amt < 0 && !(input.note ?? "").trim()) throw new AppError("VALIDATION", "Explain the correction in the note.");
    const fx = await this.resolveRate(access.organizationId, src.currency, base, input.receivedDate, input.fxRate);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(fundingTransactions)
        .values({ projectId: src.projectId, fundingSourceId: sourceId, receivedDate: input.receivedDate, amountMinor: amt, currency: src.currency, fxRate: fx.rate, fxDate: fx.fxDate, baseAmountMinor: convertMinor(amt, src.currency, base, fx.rate), note: (input.note ?? "").slice(0, 1000), recordedByUserId: actorUserId })
        .returning();
      await this.audit(tx, src.projectId, actorUserId, amt < 0 ? "funding.receipt.reversed" : "funding.receipt.recorded", "funding_transaction", row!.id, null, row);
      return row!;
    }).then(async (row) => {
      await notify(this.db, { userIds: await projectRecipients(this.db, src.projectId, "finance.read", [actorUserId]), kind: "finance.funding", title: amt < 0 ? `Funding correction: ${src.name}` : `Funding received: ${src.name}`, body: `${formatMoney(Math.abs(amt), src.currency)} ${amt < 0 ? "reversed from" : "received from"} ${src.name} on ${input.receivedDate}.`, link: `/app/projects/${src.projectId}/finance`, projectId: src.projectId });
      return row;
    });
  }

  // ----- Budget versions ---------------------------------------------------

  async listBudgets(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, "finance.read", { requireEnabled: false });
    const versions = await this.db.select().from(budgetVersions).where(eq(budgetVersions.projectId, projectId)).orderBy(desc(budgetVersions.number));
    const ids = versions.map((v) => v.id);
    const lines = ids.length ? await this.db.select().from(budgetAllocations).where(inArray(budgetAllocations.versionId, ids)) : [];
    return versions.map((v) => ({ ...v, lines: lines.filter((l) => l.versionId === v.id) }));
  }

  /** Returns the project's draft budget, creating one from the approved budget if needed. */
  async draft(actorUserId: string, projectId: string) {
    const { base } = await this.guard(actorUserId, projectId, "finance.manage", { write: true });
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from research_projects where id = ${projectId} for update`);
      const [existing] = await tx.select().from(budgetVersions).where(and(eq(budgetVersions.projectId, projectId), eq(budgetVersions.status, "draft")));
      if (existing) return existing;
      const [m] = await tx.select({ n: max(budgetVersions.number) }).from(budgetVersions).where(eq(budgetVersions.projectId, projectId));
      const number = (m?.n ?? 0) + 1;
      const [approved] = await tx.select().from(budgetVersions).where(and(eq(budgetVersions.projectId, projectId), eq(budgetVersions.status, "approved")));
      const [v] = await tx
        .insert(budgetVersions)
        .values({ projectId, number, name: number === 1 ? "Initial budget" : `Revision ${number - 1}`, baseCurrency: base, totalBaseMinor: approved?.totalBaseMinor ?? 0, createdByUserId: actorUserId })
        .returning();
      if (approved) {
        const lines = await tx.select().from(budgetAllocations).where(eq(budgetAllocations.versionId, approved.id));
        if (lines.length) await tx.insert(budgetAllocations).values(lines.map((l) => ({ versionId: v!.id, categoryKey: l.categoryKey, fundingSourceId: l.fundingSourceId, amountBaseMinor: l.amountBaseMinor, note: l.note })));
      }
      await this.audit(tx, projectId, actorUserId, "budget.draft.created", "budget_version", v!.id, null, { number });
      return v!;
    });
  }

  private async draftFor(actorUserId: string, versionId: string) {
    const [v] = await this.db.select().from(budgetVersions).where(eq(budgetVersions.id, versionId));
    if (!v) throw new AppError("NOT_FOUND", "Budget not found.");
    const g = await this.guard(actorUserId, v.projectId, "finance.manage", { write: true });
    if (v.status !== "draft") throw new AppError("READ_ONLY", "Approved budgets can't be edited. Start a revision instead.");
    return { v, ...g };
  }

  /** Sets (or clears, with 0) one allocation line of a draft budget. */
  async setAllocation(actorUserId: string, versionId: string, input: { categoryKey: string; fundingSourceId?: string | null; amount: string; note?: string }) {
    const { v, access } = await this.draftFor(actorUserId, versionId);
    await this.assertCategory(access.organizationId, input.categoryKey);
    const fundingSourceId = input.fundingSourceId || null;
    if (fundingSourceId) {
      const [fs] = await this.db.select({ id: fundingSources.id }).from(fundingSources).where(and(eq(fundingSources.id, fundingSourceId), eq(fundingSources.projectId, v.projectId)));
      if (!fs) throw new AppError("VALIDATION", "That funding source belongs to another project.");
    }
    const amt = nonNegative(input.amount, v.baseCurrency);
    await this.db.transaction(async (tx) => {
      const match = and(eq(budgetAllocations.versionId, versionId), eq(budgetAllocations.categoryKey, input.categoryKey), fundingSourceId ? eq(budgetAllocations.fundingSourceId, fundingSourceId) : isNull(budgetAllocations.fundingSourceId));
      await tx.delete(budgetAllocations).where(match);
      if (amt > 0) await tx.insert(budgetAllocations).values({ versionId, categoryKey: input.categoryKey, fundingSourceId, amountBaseMinor: amt, note: (input.note ?? "").slice(0, 500) });
      const [t] = await tx.select({ s: sql<number>`coalesce(sum(${budgetAllocations.amountBaseMinor}), 0)`.mapWith(Number) }).from(budgetAllocations).where(eq(budgetAllocations.versionId, versionId));
      await tx.update(budgetVersions).set({ totalBaseMinor: t?.s ?? 0 }).where(eq(budgetVersions.id, versionId));
    });
  }

  async updateDraftDetails(actorUserId: string, versionId: string, input: { name?: string; notes?: string }) {
    await this.draftFor(actorUserId, versionId);
    await this.db.update(budgetVersions).set({ ...(input.name?.trim() ? { name: input.name.trim().slice(0, 200) } : {}), ...(input.notes !== undefined ? { notes: input.notes.slice(0, 2000) } : {}) }).where(eq(budgetVersions.id, versionId));
  }

  async discardDraft(actorUserId: string, versionId: string) {
    const { v } = await this.draftFor(actorUserId, versionId);
    await this.db.transaction(async (tx) => {
      await tx.delete(budgetVersions).where(eq(budgetVersions.id, versionId));
      await this.audit(tx, v.projectId, actorUserId, "budget.draft.discarded", "budget_version", versionId, { number: v.number }, null);
    });
  }

  /** Approves a draft budget. The previous approved version is kept, marked superseded. */
  async approveBudget(actorUserId: string, versionId: string) {
    const [v] = await this.db.select().from(budgetVersions).where(eq(budgetVersions.id, versionId));
    if (!v) throw new AppError("NOT_FOUND", "Budget not found.");
    await this.guard(actorUserId, v.projectId, "finance.approve", { write: true });
    if (v.status !== "draft") throw new AppError("CONFLICT", "This budget has already been approved.");
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from research_projects where id = ${v.projectId} for update`);
      const [prev] = await tx.select().from(budgetVersions).where(and(eq(budgetVersions.projectId, v.projectId), eq(budgetVersions.status, "approved")));
      if (prev) await tx.update(budgetVersions).set({ status: "superseded" }).where(eq(budgetVersions.id, prev.id));
      await tx.update(budgetVersions).set({ status: "approved", approvedByUserId: actorUserId, approvedAt: new Date() }).where(and(eq(budgetVersions.id, versionId), eq(budgetVersions.status, "draft")));
      await this.audit(tx, v.projectId, actorUserId, "budget.approved", "budget_version", versionId, prev ? { superseded: prev.id, total: prev.totalBaseMinor } : null, { number: v.number, total: v.totalBaseMinor });
    });
  }

  // ----- Expenses ----------------------------------------------------------

  async listExpenses(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, "finance.read", { requireEnabled: false });
    const rows = await this.db
      .select({ e: projectExpenses, taskTitle: researchTasks.title, submitter: userProfiles.displayName })
      .from(projectExpenses)
      .leftJoin(researchTasks, eq(researchTasks.id, projectExpenses.taskId))
      .leftJoin(userProfiles, eq(userProfiles.userId, projectExpenses.submittedByUserId))
      .where(eq(projectExpenses.projectId, projectId))
      .orderBy(desc(projectExpenses.expenseDate), desc(projectExpenses.createdAt));
    const ids = rows.map((r) => r.e.id);
    const [att, hist] = ids.length
      ? await Promise.all([
          this.db.select({ expenseId: expenseAttachments.expenseId, fileId: files.id, name: files.originalName }).from(expenseAttachments).innerJoin(files, eq(files.id, expenseAttachments.fileId)).where(inArray(expenseAttachments.expenseId, ids)),
          this.db.select({ h: expenseApprovals, name: userProfiles.displayName }).from(expenseApprovals).leftJoin(userProfiles, eq(userProfiles.userId, expenseApprovals.actorUserId)).where(inArray(expenseApprovals.expenseId, ids)).orderBy(asc(expenseApprovals.createdAt)),
        ])
      : [[], []];
    return rows.map((r) => ({ ...r, attachments: att.filter((a) => a.expenseId === r.e.id), history: hist.filter((h) => h.h.expenseId === r.e.id) }));
  }

  private async expenseFields(organizationId: string, projectId: string, base: string, input: Record<string, unknown>) {
    const d = parse(
      z.object({
        description: z.string().trim().min(1, "Describe the expense").max(500),
        categoryKey: z.string().min(1, "Choose a category"),
        expenseDate: iso,
        vendor: z.string().trim().max(200).default(""),
        paymentMethod: z.enum(PAYMENT_METHODS).default("other"),
        taskId: optUuid,
        fundingSourceId: optUuid,
        recurring: z.boolean().default(false),
        notes: z.string().trim().max(2000).default(""),
      }),
      input,
    );
    await this.assertCategory(organizationId, d.categoryKey);
    if (d.taskId) {
      const [t] = await this.db.select({ id: researchTasks.id }).from(researchTasks).where(and(eq(researchTasks.id, d.taskId), eq(researchTasks.projectId, projectId)));
      if (!t) throw new AppError("VALIDATION", "That task belongs to another project.");
    }
    if (d.fundingSourceId) {
      const [f] = await this.db.select({ id: fundingSources.id }).from(fundingSources).where(and(eq(fundingSources.id, d.fundingSourceId), eq(fundingSources.projectId, projectId)));
      if (!f) throw new AppError("VALIDATION", "That funding source belongs to another project.");
    }
    const cur = String(input.currency || base).toUpperCase();
    if (!isCurrency(cur)) throw new AppError("VALIDATION", "Choose a valid currency.");
    const amt = amount(input.amount, cur);
    const fx = await this.resolveRate(organizationId, cur, base, d.expenseDate, input.fxRate as string | undefined);
    return { ...d, currency: cur, amountMinor: amt, fxRate: fx.rate, fxDate: fx.fxDate, baseAmountMinor: convertMinor(amt, cur, base, fx.rate) };
  }

  async createExpense(actorUserId: string, projectId: string, input: Record<string, unknown> & { submit?: boolean }) {
    const { access, base } = await this.guard(actorUserId, projectId, "finance.manage", { write: true });
    const fields = await this.expenseFields(access.organizationId, projectId, base, input);
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(projectExpenses)
        .values({ ...fields, projectId, createdByUserId: actorUserId, status: input.submit ? "submitted" : "draft", submittedByUserId: input.submit ? actorUserId : null, submittedAt: input.submit ? now : null })
        .returning();
      if (input.submit) await tx.insert(expenseApprovals).values({ expenseId: row!.id, action: "submit", fromStatus: "draft", toStatus: "submitted", actorUserId });
      await this.audit(tx, projectId, actorUserId, "expense.created", "expense", row!.id, null, row);
      return row!;
    }).then(async (row) => {
      if (input.submit) await this.expenseSubmitted(actorUserId, row);
      return row;
    });
  }

  private async expenseSubmitted(actorUserId: string, e: typeof projectExpenses.$inferSelect) {
    const title = await this.projectTitle(e.projectId);
    await notify(this.db, {
      userIds: await projectRecipients(this.db, e.projectId, "finance.approve", [actorUserId]),
      kind: "finance.expense_pending",
      title: `Expense awaiting approval: ${e.description}`.slice(0, 200),
      body: `An expense of ${formatMoney(e.amountMinor, e.currency)} on “${title}” is waiting for approval.`,
      link: `/app/projects/${e.projectId}/finance`,
      projectId: e.projectId,
      dedupeKey: `expense.pending:${e.id}:${e.version}`,
    });
  }

  /** Alerts finance readers when committed + actual spending crosses the alert threshold or the whole budget. */
  private async checkBudgetAlert(actorUserId: string, projectId: string) {
    const d = await this.dashboard(actorUserId, projectId).catch(() => null);
    const pct = d?.utilisationPercent;
    if (pct == null || !d) return;
    const threshold = d.settings.alertThresholdPercent;
    const level = pct >= 100 ? 100 : pct >= threshold ? threshold : null;
    if (level == null) return;
    const title = await this.projectTitle(projectId);
    await notify(this.db, {
      userIds: await projectRecipients(this.db, projectId, "finance.read"),
      kind: "finance.budget_threshold",
      title: level === 100 ? `Budget fully used: “${title}”` : `Budget ${threshold}% used: “${title}”`,
      body: `Committed and actual spending is now ${pct}% of the approved budget.`,
      link: `/app/projects/${projectId}/finance`,
      projectId,
      dedupeKey: `budget:${projectId}:${d.budget}:${level}`,
    });
  }

  private async expense(actorUserId: string, expenseId: string, perm: Perm) {
    const [e] = await this.db.select().from(projectExpenses).where(eq(projectExpenses.id, expenseId));
    if (!e) throw new AppError("NOT_FOUND", "Expense not found.");
    const g = await this.guard(actorUserId, e.projectId, perm, { write: true });
    return { e, ...g };
  }

  /** Only drafts and rejected expenses can be edited; anything approved is changed through status actions. */
  async updateExpense(actorUserId: string, expenseId: string, input: Record<string, unknown>, expectedVersion?: number) {
    const { e, access, base } = await this.expense(actorUserId, expenseId, "finance.manage");
    if (e.status !== "draft" && e.status !== "rejected") throw new AppError("READ_ONLY", "Only draft or rejected expenses can be edited.");
    if (expectedVersion !== undefined && expectedVersion !== e.version) throw new AppError("CONFLICT", "This expense was changed by someone else. Reload and try again.");
    const fields = await this.expenseFields(access.organizationId, e.projectId, base, input);
    await this.db.transaction(async (tx) => {
      const [after] = await tx
        .update(projectExpenses)
        .set({ ...fields, version: sql`${projectExpenses.version} + 1`, updatedAt: new Date() })
        .where(and(eq(projectExpenses.id, expenseId), eq(projectExpenses.version, e.version)))
        .returning();
      if (!after) throw new AppError("CONFLICT", "This expense was changed by someone else. Reload and try again.");
      await this.audit(tx, e.projectId, actorUserId, "expense.updated", "expense", expenseId, e, after);
    });
  }

  async deleteExpense(actorUserId: string, expenseId: string) {
    const { e } = await this.expense(actorUserId, expenseId, "finance.manage");
    if (e.status !== "draft") throw new AppError("READ_ONLY", "Only drafts can be deleted. Cancel submitted or approved expenses instead, so the record is kept.");
    await this.db.transaction(async (tx) => {
      await tx.delete(projectExpenses).where(eq(projectExpenses.id, expenseId));
      await this.audit(tx, e.projectId, actorUserId, "expense.deleted", "expense", expenseId, e, null);
    });
  }

  /**
   * Status workflow:
   *   draft/rejected → submitted (manage) → approved | rejected (approve)
   *   approved → paid (manage) → reimbursed (manage)
   *   submitted | approved → cancelled (manage or approve; reason required)
   */
  async transitionExpense(actorUserId: string, expenseId: string, action: "submit" | "approve" | "reject" | "pay" | "reimburse" | "cancel", input: { note?: string; paidAt?: string } = {}) {
    const perm: Perm = action === "approve" || action === "reject" ? "finance.approve" : "finance.manage";
    const [e0] = await this.db.select().from(projectExpenses).where(eq(projectExpenses.id, expenseId));
    if (!e0) throw new AppError("NOT_FOUND", "Expense not found.");
    const access = await getProjectAccess(this.db, actorUserId, e0.projectId);
    const allowed = action === "cancel" ? access.permissions.has("finance.manage") || access.permissions.has("finance.approve") : access.permissions.has(perm);
    if (!allowed) throw new AppError("FORBIDDEN", "You do not have permission to do that.");
    const { e } = await this.expense(actorUserId, expenseId, "finance.read");
    const from = e.status as ExpenseStatus;
    const map: Record<typeof action, { from: ExpenseStatus[]; to: ExpenseStatus }> = {
      submit: { from: ["draft", "rejected"], to: "submitted" },
      approve: { from: ["submitted"], to: "approved" },
      reject: { from: ["submitted"], to: "rejected" },
      pay: { from: ["approved"], to: "paid" },
      reimburse: { from: ["paid"], to: "reimbursed" },
      cancel: { from: ["submitted", "approved"], to: "cancelled" },
    };
    const rule = map[action];
    if (!rule.from.includes(from)) throw new AppError("VALIDATION", `A ${from} expense can't be ${action === "pay" ? "marked paid" : `${action}ed`}.`);
    const note = (input.note ?? "").trim().slice(0, 1000);
    if ((action === "reject" || action === "cancel") && !note) throw new AppError("VALIDATION", "Give a reason.");
    if (action === "pay" && input.paidAt) parse(iso, input.paidAt);
    const now = new Date();
    const patch: Partial<typeof projectExpenses.$inferInsert> = { status: rule.to, updatedAt: now };
    if (action === "submit") Object.assign(patch, { submittedByUserId: actorUserId, submittedAt: now });
    if (action === "approve") Object.assign(patch, { approvedByUserId: actorUserId, approvedAt: now });
    if (action === "pay") patch.paidAt = input.paidAt || now.toISOString().slice(0, 10);
    const selfApproved = action === "approve" && e.submittedByUserId === actorUserId;
    await this.db.transaction(async (tx) => {
      const [after] = await tx
        .update(projectExpenses)
        .set({ ...patch, version: sql`${projectExpenses.version} + 1` })
        .where(and(eq(projectExpenses.id, expenseId), eq(projectExpenses.status, from)))
        .returning();
      if (!after) throw new AppError("CONFLICT", "This expense changed in the meantime. Reload and try again.");
      await tx.insert(expenseApprovals).values({ expenseId, action, fromStatus: from, toStatus: rule.to, actorUserId, note, selfApproved });
      await this.audit(tx, e.projectId, actorUserId, `expense.${action}`, "expense", expenseId, { status: from }, { status: rule.to, note, selfApproved });
    });
    if (action === "submit") await this.expenseSubmitted(actorUserId, { ...e, version: e.version + 1 });
    if (action === "approve" || action === "pay") await this.checkBudgetAlert(actorUserId, e.projectId);
    return { status: rule.to, selfApproved };
  }

  async attachReceipt(actorUserId: string, expenseId: string, fileId: string) {
    const { e, access } = await this.expense(actorUserId, expenseId, "finance.manage");
    const [f] = await this.db.select().from(files).where(eq(files.id, fileId));
    if (!f || f.organizationId !== access.organizationId || f.deletedAt || (f.projectId && f.projectId !== e.projectId)) throw new AppError("VALIDATION", "Choose a file from this project.");
    await this.db.insert(expenseAttachments).values({ expenseId, fileId, addedByUserId: actorUserId }).onConflictDoNothing();
    await this.audit(this.db, e.projectId, actorUserId, "expense.receipt.attached", "expense", expenseId, null, { fileId, name: f.originalName });
  }

  // ----- Task cost estimates ----------------------------------------------

  async listEstimates(actorUserId: string, projectId: string) {
    await this.guard(actorUserId, projectId, "finance.read", { requireEnabled: false });
    return this.db.select().from(taskCostEstimates).where(eq(taskCostEstimates.projectId, projectId));
  }

  async setEstimate(actorUserId: string, taskId: string, input: { categoryKey: string; amount: string; note?: string }) {
    const [t] = await this.db.select().from(researchTasks).where(eq(researchTasks.id, taskId));
    if (!t) throw new AppError("NOT_FOUND", "Task not found.");
    const { access, base } = await this.guard(actorUserId, t.projectId, "finance.manage", { write: true });
    await this.assertCategory(access.organizationId, input.categoryKey);
    const amt = nonNegative(input.amount, base);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(taskCostEstimates).where(and(eq(taskCostEstimates.taskId, taskId), eq(taskCostEstimates.categoryKey, input.categoryKey)));
      if (amt === 0) await tx.delete(taskCostEstimates).where(and(eq(taskCostEstimates.taskId, taskId), eq(taskCostEstimates.categoryKey, input.categoryKey)));
      else
        await tx
          .insert(taskCostEstimates)
          .values({ projectId: t.projectId, taskId, categoryKey: input.categoryKey, amountBaseMinor: amt, note: (input.note ?? "").slice(0, 500), createdByUserId: actorUserId })
          .onConflictDoUpdate({ target: [taskCostEstimates.taskId, taskCostEstimates.categoryKey], set: { amountBaseMinor: amt, note: (input.note ?? "").slice(0, 500), updatedAt: new Date() } });
      await this.audit(tx, t.projectId, actorUserId, "estimate.set", "task_cost_estimate", before?.id ?? null, before ?? null, { taskId, categoryKey: input.categoryKey, amount: amt });
    });
  }

  // ----- Dashboard ---------------------------------------------------------

  async dashboard(actorUserId: string, projectId: string) {
    const { settings, base, access } = await this.guard(actorUserId, projectId, "finance.read");
    const [budgets, expenses, funding, estimates, tasks, cats] = await Promise.all([
      this.listBudgets(actorUserId, projectId),
      this.db.select().from(projectExpenses).where(eq(projectExpenses.projectId, projectId)),
      this.listFunding(actorUserId, projectId),
      this.db.select().from(taskCostEstimates).where(eq(taskCostEstimates.projectId, projectId)),
      this.db.select({ id: researchTasks.id, status: researchTasks.status, title: researchTasks.title }).from(researchTasks).where(eq(researchTasks.projectId, projectId)),
      this.categories(access.organizationId),
    ]);
    return { settings: settings!, base, ...summarise({ budgets, expenses, funding, estimates, tasks, categories: cats }) };
  }

  async auditTrail(actorUserId: string, projectId: string, limit = 100) {
    await this.guard(actorUserId, projectId, "finance.read", { requireEnabled: false });
    return this.db
      .select({ a: financialAuditEvents, name: userProfiles.displayName })
      .from(financialAuditEvents)
      .leftJoin(userProfiles, eq(userProfiles.userId, financialAuditEvents.actorUserId))
      .where(eq(financialAuditEvents.projectId, projectId))
      .orderBy(desc(financialAuditEvents.createdAt))
      .limit(limit);
  }

  async projectTitle(projectId: string) {
    const [p] = await this.db.select({ title: researchProjects.title }).from(researchProjects).where(eq(researchProjects.id, projectId));
    return p?.title ?? "Project";
  }
}

export const BUCKET: Record<ExpenseStatus, "pending" | "committed" | "actual" | null> = {
  draft: null,
  rejected: null,
  cancelled: null,
  submitted: "pending",
  approved: "committed",
  paid: "actual",
  reimbursed: "actual",
};

type Budget = Awaited<ReturnType<FinanceService["listBudgets"]>>[number];
type Expense = typeof projectExpenses.$inferSelect;

/**
 * Pure aggregation (unit-tested). All figures are base-currency minor units.
 *   remaining   = approved budget − committed − actual  (pending is shown, not deducted)
 *   utilisation = (committed + actual) / approved budget
 *   forecast    = actual + committed + pending + outstanding task estimates
 *     where a task's outstanding estimate = max(0, estimate − spending linked to it), for unfinished tasks
 */
export function summarise(input: {
  budgets: Budget[];
  expenses: Expense[];
  funding: { sources: (typeof fundingSources.$inferSelect)[]; receipts: (typeof fundingTransactions.$inferSelect)[] };
  estimates: (typeof taskCostEstimates.$inferSelect)[];
  tasks: { id: string; status: string; title: string }[];
  categories: { key: string; name: string }[];
}) {
  const approved = input.budgets.find((b) => b.status === "approved") ?? null;
  const draft = input.budgets.find((b) => b.status === "draft") ?? null;
  const totals = { pending: 0, committed: 0, actual: 0 };
  const byCat = new Map<string, { budget: number; estimated: number; pending: number; committed: number; actual: number }>();
  const cat = (k: string) => {
    if (!byCat.has(k)) byCat.set(k, { budget: 0, estimated: 0, pending: 0, committed: 0, actual: 0 });
    return byCat.get(k)!;
  };
  for (const l of approved?.lines ?? []) cat(l.categoryKey).budget += l.amountBaseMinor;
  const spentByTask = new Map<string, number>();
  const monthly = new Map<string, { committed: number; actual: number }>();
  for (const e of input.expenses) {
    const b = BUCKET[e.status as ExpenseStatus];
    if (!b) continue;
    totals[b] += e.baseAmountMinor;
    cat(e.categoryKey)[b] += e.baseAmountMinor;
    if (e.taskId) spentByTask.set(e.taskId, (spentByTask.get(e.taskId) ?? 0) + e.baseAmountMinor);
    if (b !== "pending") {
      const m = e.expenseDate.slice(0, 7);
      if (!monthly.has(m)) monthly.set(m, { committed: 0, actual: 0 });
      monthly.get(m)![b] += e.baseAmountMinor;
    }
  }
  const taskStatus = new Map(input.tasks.map((t) => [t.id, t.status]));
  const estByTask = new Map<string, number>();
  for (const est of input.estimates) {
    cat(est.categoryKey).estimated += est.amountBaseMinor;
    estByTask.set(est.taskId, (estByTask.get(est.taskId) ?? 0) + est.amountBaseMinor);
  }
  let outstandingEstimates = 0;
  for (const [taskId, est] of estByTask) {
    const st = taskStatus.get(taskId);
    if (st === "done" || st === "cancelled") continue;
    outstandingEstimates += Math.max(0, est - (spentByTask.get(taskId) ?? 0));
  }
  const budget = approved?.totalBaseMinor ?? 0;
  const received = input.funding.receipts.reduce((a, r) => a + r.baseAmountMinor, 0);
  const names = new Map(input.categories.map((c) => [c.key, c.name]));
  const funding = input.funding.sources.map((s) => {
    const rec = input.funding.receipts.filter((r) => r.fundingSourceId === s.id);
    const receivedOrig = rec.reduce((a, r) => a + r.amountMinor, 0);
    const spent = input.expenses.filter((e) => e.fundingSourceId === s.id && (BUCKET[e.status as ExpenseStatus] === "actual" || BUCKET[e.status as ExpenseStatus] === "committed")).reduce((a, e) => a + e.baseAmountMinor, 0);
    return { source: s, receivedOrig, receivedBase: rec.reduce((a, r) => a + r.baseAmountMinor, 0), outstandingOrig: Math.max(0, s.awardedMinor - receivedOrig), spentBase: spent };
  });
  return {
    approved,
    draft,
    budget,
    ...totals,
    remaining: budget - totals.committed - totals.actual,
    utilisationPercent: budget > 0 ? Math.round(((totals.committed + totals.actual) / budget) * 1000) / 10 : null,
    receivedBase: received,
    forecast: totals.actual + totals.committed + totals.pending + outstandingEstimates,
    outstandingEstimates,
    categories: [...byCat.entries()].map(([key, v]) => ({ key, name: names.get(key) ?? key, ...v })).sort((a, b) => b.budget + b.actual + b.committed - (a.budget + a.actual + a.committed)),
    monthly: [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    funding,
  };
}

export type FinanceSummary = ReturnType<typeof summarise>;
