import { creditLedgerEntries, type Database, type DbOrTx, organizations, pricingItems, pricingVersions, spendingLimits, usageRecords } from "@researchmate/database";
import { getEntitlements, limitOf } from "@researchmate/entitlements";
import { AppError } from "@researchmate/shared";
import { notify, requireOrgPermission } from "@researchmate/tenancy";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/** customer price = provider cost / (1 − margin), rounded up to the micro-dollar. */
export function customerPrice(costMicros: number, marginBps: number): number {
  if (costMicros <= 0) return 0;
  return Math.ceil((costMicros * 10_000) / (10_000 - marginBps));
}

export function tokenCost(inputTokens: number, outputTokens: number, item: { inputCostMicrosPerMTok: number | null; outputCostMicrosPerMTok: number | null }): number {
  return Math.ceil((inputTokens * (item.inputCostMicrosPerMTok ?? 0) + outputTokens * (item.outputCostMicrosPerMTok ?? 0)) / 1_000_000);
}

export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7);
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const formatUsd = (micros: number) => `${micros < 0 ? "−" : ""}$${(Math.abs(micros) / 1e6).toFixed(Math.abs(micros) < 10_000 && micros !== 0 ? 4 : 2)}`;

const itemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ai_model"), providerKey: z.string().min(2).max(40), modelId: z.string().min(1).max(200), inputCostMicrosPerMTok: z.number().int().min(0), outputCostMicrosPerMTok: z.number().int().min(0), marginBpsOverride: z.number().int().min(0).max(9499).nullable().optional() }),
  z.object({ kind: z.literal("service"), serviceKey: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), unit: z.string().min(1).max(40), unitCostMicros: z.number().int().min(0), marginBpsOverride: z.number().int().min(0).max(9499).nullable().optional() }),
]);

export interface Balance {
  creditMicros: number;
  allowanceMicros: number;
  allowanceUsedMicros: number;
  allowanceRemainingMicros: number;
  /** Platform charges this calendar month (both pools). */
  monthSpendMicros: number;
  /** Estimates held by queued or running platform jobs. */
  reservedMicros: number;
  availableMicros: number;
  monthlyCapMicros: number | null;
  perRunCapMicros: number | null;
  period: string;
}

/**
 * Pricing versions, the money ledger, spending limits and budget checks.
 * All amounts are micro-USD.
 */
export class LedgerService {
  constructor(private readonly db: Database) {}

  // ----- Pricing -----------------------------------------------------------

  async activePricing() {
    const [v] = await this.db.select().from(pricingVersions).where(eq(pricingVersions.status, "active"));
    if (!v) return null;
    const items = await this.db.select().from(pricingItems).where(eq(pricingItems.pricingVersionId, v.id));
    return { version: v, items };
  }

  async listPricing() {
    const versions = await this.db.select().from(pricingVersions).orderBy(desc(pricingVersions.version));
    const items = versions.length ? await this.db.select().from(pricingItems).where(inArray(pricingItems.pricingVersionId, versions.map((v) => v.id))).orderBy(asc(pricingItems.kind), asc(pricingItems.providerKey), asc(pricingItems.modelId), asc(pricingItems.serviceKey)) : [];
    return versions.map((v) => ({ version: v, items: items.filter((i) => i.pricingVersionId === v.id) }));
  }

  /** Drafts a new pricing version (platform administrators only; checked by the caller). */
  async draftPricing(adminUserId: string, input: { targetMarginBps: number; notes?: string; items: unknown[] }) {
    if (!Number.isInteger(input.targetMarginBps) || input.targetMarginBps < 0 || input.targetMarginBps >= 9500) throw new AppError("VALIDATION", "The target margin must be between 0 % and 94.99 %.");
    const items = input.items.map((i, n) => {
      const r = itemSchema.safeParse(i);
      if (!r.success) throw new AppError("VALIDATION", `Price line ${n + 1}: ${r.error.issues[0]!.path.join(".")} ${r.error.issues[0]!.message}`);
      return r.data;
    });
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table pricing_versions in share row exclusive mode`);
      const [{ next }] = (await tx.execute<{ next: number }>(sql`select coalesce(max(version), 0)::int + 1 as next from pricing_versions`)) as unknown as [{ next: number }];
      const [v] = await tx.insert(pricingVersions).values({ version: next, targetMarginBps: input.targetMarginBps, notes: String(input.notes ?? "").slice(0, 1000), createdByUserId: adminUserId }).returning();
      if (items.length)
        await tx.insert(pricingItems).values(
          items.map((i) =>
            i.kind === "ai_model"
              ? { pricingVersionId: v!.id, kind: "ai_model", providerKey: i.providerKey, modelId: i.modelId, unit: "mtok", inputCostMicrosPerMTok: i.inputCostMicrosPerMTok, outputCostMicrosPerMTok: i.outputCostMicrosPerMTok, marginBpsOverride: i.marginBpsOverride ?? null }
              : { pricingVersionId: v!.id, kind: "service", serviceKey: i.serviceKey, unit: i.unit, unitCostMicros: i.unitCostMicros, marginBpsOverride: i.marginBpsOverride ?? null },
          ),
        );
      return v!;
    });
  }

  /** Activates a draft; the previously active version is retired. Prices of active versions are immutable. */
  async activatePricing(versionId: string) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(pricingVersions).where(eq(pricingVersions.id, versionId)).for("update");
      if (!v || v.status !== "draft") throw new AppError("CONFLICT", "Only a draft can be activated.");
      await tx.update(pricingVersions).set({ status: "retired", retiredAt: new Date() }).where(eq(pricingVersions.status, "active"));
      await tx.update(pricingVersions).set({ status: "active", activatedAt: new Date() }).where(eq(pricingVersions.id, versionId));
    });
  }

  /** Price for an AI model under the active version, or null when the model is unpriced. */
  async aiPrice(providerKey: string, modelId: string) {
    const p = await this.activePricing();
    const item = p?.items.find((i) => i.kind === "ai_model" && i.providerKey === providerKey && i.modelId === modelId);
    if (!p || !item) return null;
    return { pricingVersionId: p.version.id, item, marginBps: item.marginBpsOverride ?? p.version.targetMarginBps };
  }

  async servicePrice(serviceKey: string) {
    const p = await this.activePricing();
    const item = p?.items.find((i) => i.kind === "service" && i.serviceKey === serviceKey);
    if (!p || !item) return null;
    return { pricingVersionId: p.version.id, item, marginBps: item.marginBpsOverride ?? p.version.targetMarginBps };
  }

  // ----- Balances and limits ----------------------------------------------

  async balance(organizationId: string, db: DbOrTx = this.db): Promise<Balance> {
    const period = periodOf();
    const ent = await getEntitlements(db, organizationId);
    const allowance = limitOf(ent, "ai.platform.allowance") ?? 0;
    const [sums] = (await db.execute<{ credit: string; allowance_used: string; month_spend: string; reserved: string }>(sql`
      select
        coalesce((select sum(amount_micros) from credit_ledger_entries where organization_id = ${organizationId} and pool = 'credit'), 0) as credit,
        coalesce((select -sum(amount_micros) from credit_ledger_entries where organization_id = ${organizationId} and pool = 'allowance' and period = ${period}), 0) as allowance_used,
        coalesce((select -sum(amount_micros) from credit_ledger_entries where organization_id = ${organizationId} and kind = 'usage' and created_at >= ${monthStart().toISOString()}::timestamptz), 0) as month_spend,
        coalesce((select sum(estimated_charge_micros) from ai_runs where organization_id = ${organizationId} and funding = 'platform' and status in ('queued', 'running')), 0) as reserved`)) as unknown as [{ credit: string; allowance_used: string; month_spend: string; reserved: string }];
    const [lim] = await db.select().from(spendingLimits).where(eq(spendingLimits.organizationId, organizationId));
    const credit = Number(sums.credit);
    const used = Number(sums.allowance_used);
    const remaining = Math.max(0, allowance - used);
    const reserved = Number(sums.reserved);
    return {
      creditMicros: credit,
      allowanceMicros: allowance,
      allowanceUsedMicros: used,
      allowanceRemainingMicros: remaining,
      monthSpendMicros: Number(sums.month_spend),
      reservedMicros: reserved,
      availableMicros: remaining + Math.max(0, credit) - reserved,
      monthlyCapMicros: lim?.monthlyCapMicros ?? null,
      perRunCapMicros: lim?.perRunCapMicros ?? null,
      period,
    };
  }

  async setLimits(actorUserId: string, organizationId: string, input: { monthlyCapMicros: number | null; perRunCapMicros: number | null }) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    for (const v of [input.monthlyCapMicros, input.perRunCapMicros]) if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e13)) throw new AppError("VALIDATION", "Limits must be positive amounts.");
    const values = { organizationId, monthlyCapMicros: input.monthlyCapMicros, perRunCapMicros: input.perRunCapMicros, updatedByUserId: actorUserId, updatedAt: new Date() };
    await this.db.insert(spendingLimits).values(values).onConflictDoUpdate({ target: spendingLimits.organizationId, set: values });
  }

  /**
   * Can this organization spend `estimateMicros` more on platform-funded
   * usage? Considers prepaid credit, this month's allowance, amounts held by
   * jobs in flight, the monthly cap and the per-run cap.
   */
  async checkBudget(organizationId: string, estimateMicros: number, db: DbOrTx = this.db): Promise<Balance> {
    const b = await this.balance(organizationId, db);
    if (b.perRunCapMicros !== null && estimateMicros > b.perRunCapMicros) throw new AppError("QUOTA_EXCEEDED", `This run could cost up to ${formatUsd(estimateMicros)}, above your per-run limit of ${formatUsd(b.perRunCapMicros)}.`, { feature: "spending.per_run" });
    if (b.monthlyCapMicros !== null && b.monthSpendMicros + b.reservedMicros + estimateMicros > b.monthlyCapMicros) throw new AppError("QUOTA_EXCEEDED", `This would exceed your monthly spending limit of ${formatUsd(b.monthlyCapMicros)}.`, { feature: "spending.monthly" });
    if (estimateMicros > b.availableMicros) throw new AppError("QUOTA_EXCEEDED", `Not enough AI credit: this run could cost up to ${formatUsd(estimateMicros)} and ${formatUsd(Math.max(0, b.availableMicros))} is available. Buy credit or use your own key.`, { feature: "credit" });
    return b;
  }

  // ----- Ledger writes -----------------------------------------------------

  /**
   * Charges platform usage: this month's allowance first, then prepaid
   * credit (which may go slightly negative if the actual cost exceeded the
   * estimate; that overdraft is visible and repaid by the next purchase).
   * Idempotent per usage record.
   */
  async chargeUsage(db: DbOrTx, input: { organizationId: string; usageRecordId: string; amountMicros: number; pricingVersionId: string | null; description: string }) {
    if (input.amountMicros <= 0) return;
    const b = await this.balance(input.organizationId, db);
    const fromAllowance = Math.min(b.allowanceRemainingMicros, input.amountMicros);
    const fromCredit = input.amountMicros - fromAllowance;
    const base = { organizationId: input.organizationId, kind: "usage", usageRecordId: input.usageRecordId, pricingVersionId: input.pricingVersionId, description: input.description.slice(0, 300) };
    if (fromAllowance > 0) await db.insert(creditLedgerEntries).values({ ...base, pool: "allowance", period: b.period, amountMicros: -fromAllowance, idempotencyKey: `usage:${input.usageRecordId}:allowance` }).onConflictDoNothing();
    if (fromCredit > 0) await db.insert(creditLedgerEntries).values({ ...base, pool: "credit", amountMicros: -fromCredit, idempotencyKey: `usage:${input.usageRecordId}:credit` }).onConflictDoNothing();
    await this.budgetNotice(db, input.organizationId, b, fromAllowance, fromCredit, input.amountMicros);
  }

  /** Low-budget notices to the organization owner: allowance 80% used, credit under $1, monthly cap 90% reached. */
  private async budgetNotice(db: DbOrTx, organizationId: string, b: Balance, fromAllowance: number, fromCredit: number, charged: number) {
    const [org] = await db.select({ owner: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, organizationId));
    if (!org) return;
    const say = (title: string, body: string, dedupeKey: string) => notify(db, { userIds: [org.owner], kind: "ai.budget", title, body, link: "/app/settings/billing", organizationId, dedupeKey });
    const usedAfter = b.allowanceUsedMicros + fromAllowance;
    if (b.allowanceMicros > 0 && usedAfter >= b.allowanceMicros * 0.8 && b.allowanceUsedMicros < b.allowanceMicros * 0.8)
      await say("AI allowance 80% used", `This month's included AI allowance (${formatUsd(b.allowanceMicros)}) is 80% used. After that, platform AI draws on prepaid credit.`, `ai.allowance80:${organizationId}:${b.period}`);
    const ONE_DOLLAR = 1_000_000;
    const creditAfter = b.creditMicros - fromCredit;
    if (fromCredit > 0 && creditAfter < ONE_DOLLAR && b.creditMicros >= ONE_DOLLAR)
      await say("AI credit is running low", `Your prepaid AI credit is down to ${formatUsd(Math.max(0, creditAfter))}. Buy credit or add your own provider key to keep using AI features.`, `ai.credit-low:${organizationId}:${new Date().toISOString().slice(0, 10)}`);
    if (b.monthlyCapMicros !== null && b.monthlyCapMicros > 0) {
      const spend = b.monthSpendMicros + charged;
      if (spend >= b.monthlyCapMicros * 0.9 && b.monthSpendMicros < b.monthlyCapMicros * 0.9)
        await say("AI spending near the monthly limit", `AI spending this month is ${formatUsd(spend)} of your ${formatUsd(b.monthlyCapMicros)} limit. Runs that would pass the limit will be refused.`, `ai.cap90:${organizationId}:${b.period}`);
    }
  }

  async addCredit(db: DbOrTx, input: { organizationId: string; amountMicros: number; kind: "purchase" | "refund" | "adjustment"; paymentId?: string | null; description: string; idempotencyKey: string; actorUserId?: string | null }) {
    await db
      .insert(creditLedgerEntries)
      .values({ organizationId: input.organizationId, kind: input.kind, pool: "credit", amountMicros: input.amountMicros, paymentId: input.paymentId ?? null, description: input.description.slice(0, 300), idempotencyKey: input.idempotencyKey, createdByUserId: input.actorUserId ?? null })
      .onConflictDoNothing();
  }

  async entries(actorUserId: string, organizationId: string, limit = 100) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    return this.db.select().from(creditLedgerEntries).where(eq(creditLedgerEntries.organizationId, organizationId)).orderBy(desc(creditLedgerEntries.createdAt)).limit(limit);
  }

  /**
   * Transparent usage breakdown for a month: AI (by agent, model and
   * funding) and external services (OCR, crawling, Apify…) separately.
   */
  async usageBreakdown(actorUserId: string, organizationId: string, period = periodOf()) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError("VALIDATION", "Bad period.");
    const from = new Date(`${period}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const ai = (await this.db.execute(sql`
      select r.agent_key as agent, r.provider_key as provider, r.model_id as model, r.funding, count(*)::int as runs,
             sum(r.input_tokens)::bigint as input_tokens, sum(r.output_tokens)::bigint as output_tokens,
             sum(coalesce(r.customer_charge_micros, 0))::bigint as charge
      from ai_runs r where r.organization_id = ${organizationId} and r.created_at >= ${from.toISOString()}::timestamptz and r.created_at < ${to.toISOString()}::timestamptz and r.status = 'succeeded'
      group by 1, 2, 3, 4 order by charge desc, runs desc`)) as unknown as { agent: string; provider: string; model: string; funding: string; runs: number; input_tokens: string; output_tokens: string; charge: string }[];
    const services = (await this.db.execute(sql`
      select kind, unit, funding, sum(quantity)::bigint as quantity, sum(customer_charge_micros)::bigint as charge, count(*)::int as events
      from usage_records where organization_id = ${organizationId} and created_at >= ${from.toISOString()}::timestamptz and created_at < ${to.toISOString()}::timestamptz and kind not like 'ai.%'
      group by 1, 2, 3 order by charge desc`)) as unknown as { kind: string; unit: string; funding: string; quantity: string; charge: string; events: number }[];
    return {
      period,
      ai: ai.map((r) => ({ ...r, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), chargeMicros: Number(r.charge) })),
      services: services.map((s) => ({ ...s, quantity: Number(s.quantity), chargeMicros: Number(s.charge) })),
    };
  }

  /**
   * Meters an external service (OCR pages, crawl pages, Apify compute…),
   * kept separate from AI. Charged only when the service has a price in the
   * active pricing version; otherwise recorded at no charge.
   */
  async meterService(db: DbOrTx, input: { organizationId: string; projectId?: string | null; userId?: string | null; serviceKey: string; quantity: number; unit: string; sourceType: string; sourceId: string; funding?: "platform" | "byok" }) {
    if (input.quantity <= 0) return null;
    const price = input.funding === "byok" ? null : await this.servicePrice(input.serviceKey);
    const cost = price ? Math.ceil(input.quantity * (price.item.unitCostMicros ?? 0)) : null;
    const charge = price && cost !== null ? customerPrice(cost, price.marginBps) : 0;
    const [row] = await db
      .insert(usageRecords)
      .values({ organizationId: input.organizationId, projectId: input.projectId ?? null, userId: input.userId ?? null, kind: input.serviceKey, funding: input.funding ?? "platform", quantity: input.quantity, unit: input.unit, sourceType: input.sourceType, sourceId: input.sourceId, providerCostMicros: cost, customerChargeMicros: charge, pricingVersionId: price?.pricingVersionId ?? null })
      .onConflictDoNothing()
      .returning();
    if (row && charge > 0) await this.chargeUsage(db, { organizationId: input.organizationId, usageRecordId: row.id, amountMicros: charge, pricingVersionId: price!.pricingVersionId, description: `${input.serviceKey}: ${input.quantity} ${input.unit}` });
    return row ?? null;
  }

  async organizationName(organizationId: string) {
    const [o] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    return o?.name ?? "";
  }
}

