import { type Database, type EntitlementValue, FEATURES, type FeatureKey, planEntitlements, plans, pricePoints, subscriptions } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { recordAudit } from "@researchmate/tenancy";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { requirePlatformAdmin } from "./guard";
import { parseCurrency, parseEntitlementValue, parseMoneyMinor } from "./values";

const LIVE = ["active", "trialing", "past_due"] as const;

export interface PlanInput {
  name: string;
  description: string;
  /** Display price in major units ("19.99"); what the pricing page shows. */
  price: string;
  currency: string;
  billingInterval: "month" | "year";
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
}

/**
 * Plans, what each plan includes, and what customers can buy.
 *
 * A plan's `price` is what the public pricing page shows. What a customer is
 * actually charged is a price point (per currency and period), so the same
 * plan can be sold in USD by card and in KES by M-PESA. Price points are
 * never deleted (payments refer to them); they are switched off instead.
 */
export class PlanAdminService {
  constructor(private readonly db: Database) {}

  async list(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const rows = await this.db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.name));
    const ents = await this.db.select().from(planEntitlements);
    const live = await this.db.select({ planId: subscriptions.planId, n: count() }).from(subscriptions).where(inArray(subscriptions.status, [...LIVE])).groupBy(subscriptions.planId);
    const points = await this.db.select().from(pricePoints).orderBy(asc(pricePoints.kind), asc(pricePoints.currency), asc(pricePoints.amountMinor));
    return rows.map((p) => ({
      plan: p,
      entitlements: Object.fromEntries(ents.filter((e) => e.planId === p.id).map((e) => [e.featureKey, e.value])) as Partial<Record<FeatureKey, EntitlementValue>>,
      liveSubscriptions: Number(live.find((l) => l.planId === p.id)?.n ?? 0),
      pricePoints: points.filter((pp) => pp.planId === p.id),
    }));
  }

  async creditPricePoints(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    return this.db.select().from(pricePoints).where(eq(pricePoints.kind, "credits")).orderBy(asc(pricePoints.currency), asc(pricePoints.amountMinor));
  }

  private validate(input: PlanInput) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60) throw new AppError("VALIDATION", "Plan names are 2–60 characters.");
    if (!["month", "year"].includes(input.billingInterval)) throw new AppError("VALIDATION", "Choose monthly or yearly.");
    if (!Number.isInteger(input.sortOrder) || Math.abs(input.sortOrder) > 1000) throw new AppError("VALIDATION", "Order must be a whole number.");
    return {
      name,
      description: input.description.trim().slice(0, 500),
      priceMinor: input.price.trim() === "" ? 0 : parseMoneyMinor(input.price, "Price"),
      currency: parseCurrency(input.currency),
      billingInterval: input.billingInterval,
      isPublic: input.isPublic,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    };
  }

  async create(actorUserId: string, input: PlanInput & { key: string; copyFromPlanId?: string }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) throw new AppError("VALIDATION", "The plan key is 2–40 lower-case letters, digits or underscores, starting with a letter (e.g. institution_basic). It can't be changed later.");
    const v = this.validate(input);
    return this.db.transaction(async (tx) => {
      const [exists] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.key, key));
      if (exists) throw new AppError("CONFLICT", `A plan with the key “${key}” already exists.`);
      const [plan] = await tx.insert(plans).values({ key, ...v, isDefault: false }).returning();
      // Start from another plan's entitlements, or from "nothing included" for every feature.
      const source = input.copyFromPlanId ? await tx.select().from(planEntitlements).where(eq(planEntitlements.planId, input.copyFromPlanId)) : [];
      const values = (Object.keys(FEATURES) as FeatureKey[]).map((featureKey) => {
        const def = FEATURES[featureKey];
        const copied = source.find((s) => s.featureKey === featureKey);
        return { planId: plan!.id, featureKey, value: copied ? copied.value : def.kind === "limit" ? 0 : def.kind === "flag" ? false : def.tiers[0]! };
      });
      await tx.insert(planEntitlements).values(values);
      await recordAudit(tx, { actorUserId, action: "admin.plan.created", targetType: "plan", targetId: plan!.id, metadata: { key, copiedFrom: input.copyFromPlanId ?? null } });
      return plan!;
    });
  }

  async update(actorUserId: string, planId: string, input: PlanInput) {
    await requirePlatformAdmin(this.db, actorUserId);
    const v = this.validate(input);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(plans).where(eq(plans.id, planId)).for("update");
      if (!before) throw new AppError("NOT_FOUND", "No such plan.");
      if (before.isDefault && (!v.isActive || v.priceMinor > 0)) throw new AppError("VALIDATION", "The default plan must stay active and free. Make another plan the default first.");
      await tx.update(plans).set({ ...v, updatedAt: new Date() }).where(eq(plans.id, planId));
      // A retired plan can't be bought; its prices are switched off with it.
      if (before.isActive && !v.isActive) await tx.update(pricePoints).set({ active: 0 }).where(eq(pricePoints.planId, planId));
      const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => (before as Record<string, unknown>)[k] !== val).map(([k, val]) => [k, { from: (before as Record<string, unknown>)[k], to: val }]));
      await recordAudit(tx, { actorUserId, action: "admin.plan.updated", targetType: "plan", targetId: planId, metadata: { key: before.key, changed } });
    });
  }

  /** New organizations, and organizations whose paid plan ends, go to the default plan. */
  async setDefault(actorUserId: string, planId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    await this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(plans).where(eq(plans.id, planId));
      if (!p) throw new AppError("NOT_FOUND", "No such plan.");
      if (!p.isActive || p.priceMinor > 0) throw new AppError("VALIDATION", "The default plan must be active and free.");
      await tx.update(plans).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(plans.isDefault, true), ne(plans.id, planId)));
      await tx.update(plans).set({ isDefault: true, updatedAt: new Date() }).where(eq(plans.id, planId));
      await recordAudit(tx, { actorUserId, action: "admin.plan.default_set", targetType: "plan", targetId: planId, metadata: { key: p.key } });
    });
  }

  /**
   * Sets what a plan includes. Applies at once to every organization on the
   * plan (except where an organization has its own override).
   */
  async setEntitlements(actorUserId: string, planId: string, raw: Record<string, string>) {
    await requirePlatformAdmin(this.db, actorUserId);
    const parsed = Object.entries(raw).map(([k, v]) => [k, parseEntitlementValue(k, v)] as const);
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(plans).where(eq(plans.id, planId));
      if (!p) throw new AppError("NOT_FOUND", "No such plan.");
      const current = await tx.select().from(planEntitlements).where(eq(planEntitlements.planId, planId));
      const changes: Record<string, { from: EntitlementValue | undefined; to: EntitlementValue }> = {};
      for (const [featureKey, value] of parsed) {
        const before = current.find((c) => c.featureKey === featureKey);
        if (before && JSON.stringify(before.value) === JSON.stringify(value)) continue;
        changes[featureKey] = { from: before?.value, to: value };
        await tx.insert(planEntitlements).values({ planId, featureKey, value }).onConflictDoUpdate({ target: [planEntitlements.planId, planEntitlements.featureKey], set: { value } });
      }
      if (Object.keys(changes).length) await recordAudit(tx, { actorUserId, action: "admin.plan.entitlements_changed", targetType: "plan", targetId: planId, metadata: { key: p.key, changes } });
      return Object.keys(changes).length;
    });
  }

  async createPricePoint(actorUserId: string, input: { kind: "plan" | "credits"; planId?: string; interval?: "month" | "year"; currency: string; amount: string; creditUsd?: string; label: string }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const currency = parseCurrency(input.currency);
    const amountMinor = parseMoneyMinor(input.amount);
    if (amountMinor <= 0) throw new AppError("VALIDATION", "The price must be more than zero.");
    const label = input.label.trim();
    if (label.length < 2 || label.length > 120) throw new AppError("VALIDATION", "Give the price a label customers will see (2–120 characters).");
    let values: typeof pricePoints.$inferInsert;
    if (input.kind === "plan") {
      const [p] = input.planId ? await this.db.select().from(plans).where(eq(plans.id, input.planId)) : [];
      if (!p) throw new AppError("VALIDATION", "Choose the plan this price is for.");
      if (!p.isActive) throw new AppError("VALIDATION", "That plan is retired; reactivate it first.");
      if (p.isDefault) throw new AppError("VALIDATION", "The default plan is free and can't be sold.");
      if (input.interval !== "month" && input.interval !== "year") throw new AppError("VALIDATION", "Choose monthly or yearly.");
      values = { kind: "plan", planId: p.id, interval: input.interval, currency, amountMinor, label };
    } else if (input.kind === "credits") {
      const usd = Number((input.creditUsd ?? "").trim());
      if (!Number.isFinite(usd) || usd <= 0 || usd > 100_000) throw new AppError("VALIDATION", "Enter the AI credit the customer receives, in US dollars.");
      values = { kind: "credits", creditMicros: Math.round(usd * 1_000_000), currency, amountMinor, label };
    } else throw new AppError("VALIDATION", "Choose a plan price or an AI credit pack.");
    const [pp] = await this.db.insert(pricePoints).values(values).returning();
    await recordAudit(this.db, { actorUserId, action: "admin.price.created", targetType: "price_point", targetId: pp!.id, metadata: { kind: pp!.kind, planId: pp!.planId, interval: pp!.interval, currency, amountMinor, creditMicros: pp!.creditMicros, label } });
    return pp!;
  }

  async setPricePointActive(actorUserId: string, pricePointId: string, active: boolean) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [pp] = await this.db.select().from(pricePoints).where(eq(pricePoints.id, pricePointId));
    if (!pp) throw new AppError("NOT_FOUND", "No such price.");
    if (active && pp.planId) {
      const [p] = await this.db.select().from(plans).where(eq(plans.id, pp.planId));
      if (!p?.isActive) throw new AppError("VALIDATION", "That plan is retired; reactivate it first.");
    }
    await this.db.update(pricePoints).set({ active: active ? 1 : 0 }).where(eq(pricePoints.id, pricePointId));
    await recordAudit(this.db, { actorUserId, action: active ? "admin.price.activated" : "admin.price.deactivated", targetType: "price_point", targetId: pricePointId, metadata: { label: pp.label, currency: pp.currency, amountMinor: pp.amountMinor } });
  }
}
