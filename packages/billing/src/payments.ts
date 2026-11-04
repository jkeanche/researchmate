import { randomUUID } from "node:crypto";
import { type Database, type DbOrTx, invoices, organizations, paymentEvents, payments, plans, pricePoints, refunds, subscriptions, users } from "@researchmate/database";
import { AppError, logger } from "@researchmate/shared";
import { notify, requireOrgPermission } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { formatUsd, LedgerService } from "./ledger";
import type { IncomingRequest, PaymentProvider } from "./providers";

type Payment = typeof payments.$inferSelect;

export interface PaymentDeps {
  providers: PaymentProvider[];
  appUrl: string;
  /** Days after the period ends before a subscription expires (status past_due meanwhile). */
  graceDays?: number;
}

const DAY = 86_400_000;
const addInterval = (from: Date, interval: string) => {
  const d = new Date(from);
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};
export const formatMoney = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Checkout, notifications, server-side verification, fulfilment, invoices,
 * refunds and subscription periods. Subscriptions are sold as prepaid
 * periods (month/year) so they work with mobile money, which has no
 * recurring pull; renewals are reminded by email and bought the same way.
 */
export class PaymentService {
  readonly ledger: LedgerService;
  constructor(
    private readonly db: Database,
    private readonly deps: PaymentDeps,
  ) {
    this.ledger = new LedgerService(db);
  }

  provider(key: string): PaymentProvider {
    const p = this.deps.providers.find((x) => x.key === key);
    if (!p) throw new AppError("NOT_FOUND", "That payment method isn't available.");
    return p;
  }

  available() {
    return this.deps.providers.map((p) => ({ key: p.key, name: p.name, currencies: p.currencies, methods: p.methods }));
  }

  async catalogue() {
    return this.db
      .select({ p: pricePoints, planName: plans.name, planKey: plans.key })
      .from(pricePoints)
      .leftJoin(plans, eq(plans.id, pricePoints.planId))
      // A plan an administrator has retired can't be bought, even if a price is still active.
      .where(and(eq(pricePoints.active, 1), or(isNull(pricePoints.planId), eq(plans.isActive, true))))
      .orderBy(asc(pricePoints.kind), asc(pricePoints.currency), asc(pricePoints.amountMinor));
  }

  /** In-app notice plus email per the user's preferences (delivered by the worker). */
  private async tell(db: DbOrTx, userId: string | null | undefined, organizationId: string, kind: "billing.subscription" | "billing.payment_failed", title: string, body: string, dedupeKey?: string) {
    await notify(db, { userIds: [userId], kind, title, body, link: "/app/settings/billing", organizationId, dedupeKey });
  }

  // ----- Checkout ----------------------------------------------------------

  async checkout(actorUserId: string, organizationId: string, input: { pricePointId: string; provider: string }) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    const provider = this.provider(input.provider);
    const [pp] = await this.db.select().from(pricePoints).where(and(eq(pricePoints.id, input.pricePointId), eq(pricePoints.active, 1)));
    if (!pp) throw new AppError("VALIDATION", "Choose something to buy.");
    if (!provider.currencies.includes(pp.currency)) throw new AppError("VALIDATION", `${provider.name} can't take payments in ${pp.currency} here.`);
    const [u] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, actorUserId));
    const [plan] = pp.planId ? await this.db.select().from(plans).where(eq(plans.id, pp.planId)) : [];
    if (pp.planId && !plan?.isActive) throw new AppError("VALIDATION", "That plan is no longer available.");
    const reference = `rm_${randomUUID().replace(/-/g, "")}`;
    const [row] = await this.db
      .insert(payments)
      .values({ organizationId, provider: provider.key, reference, pricePointId: pp.id, kind: pp.kind, planId: pp.planId, interval: pp.interval, creditMicros: pp.creditMicros, currency: pp.currency, amountMinor: pp.amountMinor, createdByUserId: actorUserId })
      .returning();
    const base = this.deps.appUrl.replace(/\/$/, "");
    try {
      const r = await provider.createCheckout({
        reference,
        amountMinor: pp.amountMinor,
        currency: pp.currency,
        description: pp.kind === "plan" ? `ResearchMate ${plan?.name} — 1 ${pp.interval}` : `ResearchMate AI credit ${formatUsd(pp.creditMicros!)}`,
        customerEmail: u!.email,
        returnUrl: `${base}/api/payments/${provider.key}/return?ref=${reference}`,
        cancelUrl: `${base}/app/settings/billing?payment=cancelled`,
        notifyUrl: `${base}/api/payments/${provider.key}/notify`,
      });
      if (r.providerReference) await this.db.update(payments).set({ providerReference: r.providerReference, updatedAt: new Date() }).where(eq(payments.id, row!.id));
      return { paymentId: row!.id, redirectUrl: r.redirectUrl };
    } catch (err) {
      await this.db.update(payments).set({ status: "failed", providerStatus: "checkout_failed", details: { error: String((err as Error).message).slice(0, 300) }, updatedAt: new Date() }).where(eq(payments.id, row!.id));
      throw err;
    }
  }

  // ----- Notifications and verification -----------------------------------

  private async find(provider: string, ref: { reference: string | null; providerReference: string | null }) {
    if (ref.reference) {
      const [p] = await this.db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.reference, ref.reference)));
      if (p) return p;
    }
    if (ref.providerReference) {
      const [p] = await this.db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.providerReference, ref.providerReference)));
      if (p) return p;
    }
    return null;
  }

  /** Webhook / IPN entry point. Authenticity is checked by the provider; fulfilment always follows a server-side status check. */
  async handleNotification(providerKey: string, req: IncomingRequest) {
    const provider = this.provider(providerKey);
    const ref = await provider.parseNotification(req);
    const payment = await this.find(providerKey, ref);
    if (ref.eventId) {
      const inserted = await this.db.insert(paymentEvents).values({ provider: providerKey, eventId: ref.eventId, type: ref.type, paymentId: payment?.id ?? null }).onConflictDoNothing().returning();
      // A repeated delivery is acknowledged without re-applying anything; if an earlier delivery was
      // interrupted before the payment was settled, it is still reconciled (reconcile is idempotent).
      if (!inserted.length) {
        if (payment?.status === "pending") await this.reconcile(payment.id);
        return { response: provider.notificationResponse(ref), outcome: "duplicate" as const };
      }
    }
    if (!payment) {
      logger.warn("billing.notification_unknown_payment", { provider: providerKey, type: ref.type });
      return { response: provider.notificationResponse(ref), outcome: "unknown" as const };
    }
    const after = await this.reconcile(payment.id);
    if (!ref.eventId) await this.db.insert(paymentEvents).values({ provider: providerKey, eventId: `${ref.providerReference ?? ref.reference}:${after.status}:${after.refundedMinor}`, type: ref.type, paymentId: payment.id, outcome: after.status }).onConflictDoNothing();
    else await this.db.update(paymentEvents).set({ outcome: after.status }).where(and(eq(paymentEvents.provider, providerKey), eq(paymentEvents.eventId, ref.eventId)));
    return { response: provider.notificationResponse(ref), outcome: after.status };
  }

  /** Return redirect: identifies the payment and verifies it with the provider. The redirect itself proves nothing. */
  async handleReturn(providerKey: string, query: URLSearchParams) {
    const provider = this.provider(providerKey);
    const fromQuery = provider.fromReturn(query);
    const payment = await this.find(providerKey, { reference: fromQuery.reference ?? query.get("ref"), providerReference: fromQuery.providerReference });
    if (!payment) return null;
    return this.reconcile(payment.id);
  }

  /**
   * Fetches the authoritative status from the provider and applies it once.
   * Amount and currency must match what we asked for, or nothing is granted.
   */
  async reconcile(paymentId: string): Promise<Payment> {
    const [p] = await this.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!p) throw new AppError("NOT_FOUND", "Payment not found.");
    if (p.status === "failed" && p.providerStatus === "checkout_failed") return p;
    const v = await this.provider(p.provider).verify({ reference: p.reference, providerReference: p.providerReference });
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
      const details = { ...cur!.details, ...v.details };
      const patch: Partial<Payment> = { providerStatus: v.providerStatus, details, updatedAt: new Date(), ...(v.providerReference && !cur!.providerReference ? { providerReference: v.providerReference } : {}) };
      if (v.status === "succeeded" && cur!.status === "pending") {
        if (v.amountMinor !== cur!.amountMinor || (v.currency && v.currency !== cur!.currency)) {
          logger.error("billing.amount_mismatch", { paymentId, expected: `${cur!.amountMinor} ${cur!.currency}`, got: `${v.amountMinor} ${v.currency}` });
          const [row] = await tx.update(payments).set({ ...patch, status: "failed", details: { ...details, mismatch: `paid ${v.amountMinor} ${v.currency}` } }).where(eq(payments.id, paymentId)).returning();
          await this.tell(tx, row!.createdByUserId, row!.organizationId, "billing.payment_failed", "Payment could not be applied", `The amount received didn't match the ${formatMoney(row!.amountMinor, row!.currency)} requested, so nothing was applied. Contact support with reference ${row!.reference}.`, `payment-failed:${row!.id}`);
          return row!;
        }
        const [row] = await tx.update(payments).set({ ...patch, status: "succeeded", verifiedAt: new Date() }).where(eq(payments.id, paymentId)).returning();
        await this.fulfil(tx, row!);
        return row!;
      }
      if (v.status === "failed" && cur!.status === "pending") {
        const [row] = await tx.update(payments).set({ ...patch, status: "failed" }).where(eq(payments.id, paymentId)).returning();
        await this.tell(tx, row!.createdByUserId, row!.organizationId, "billing.payment_failed", "Payment failed", `Your payment of ${formatMoney(row!.amountMinor, row!.currency)} did not go through (${v.providerStatus || "declined"}). You can try again from Settings → Billing.`, `payment-failed:${row!.id}`);
        return row!;
      }
      if (v.status === "refunded" && (cur!.status === "succeeded" || cur!.status === "partially_refunded")) {
        // Reversed at the provider (chargeback or refund done there): remove any unspent credit it bought.
        const [row] = await tx.update(payments).set({ ...patch, status: "refunded", refundedMinor: cur!.amountMinor }).where(eq(payments.id, paymentId)).returning();
        if (row!.kind === "credits") await this.removeCredit(tx, row!, row!.amountMinor - cur!.refundedMinor, "reversal");
        return row!;
      }
      const [row] = await tx.update(payments).set(patch).where(eq(payments.id, paymentId)).returning();
      return row!;
    });
  }

  private async fulfil(tx: DbOrTx, p: Payment) {
    const [org] = await tx.select({ name: organizations.name, owner: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, p.organizationId));
    let line: string;
    if (p.kind === "credits") {
      await this.ledger.addCredit(tx, { organizationId: p.organizationId, amountMicros: p.creditMicros!, kind: "purchase", paymentId: p.id, description: `AI credit purchase (${formatMoney(p.amountMinor, p.currency)})`, idempotencyKey: `payment:${p.id}` });
      line = `ResearchMate AI credit ${formatUsd(p.creditMicros!)}`;
    } else {
      const end = await this.extendPlan(tx, p);
      const [plan] = await tx.select({ name: plans.name }).from(plans).where(eq(plans.id, p.planId!));
      line = `ResearchMate ${plan!.name}, 1 ${p.interval} (to ${end.toISOString().slice(0, 10)})`;
    }
    const [{ n }] = (await tx.execute<{ n: string }>(sql`select nextval('invoice_number_seq')::text as n`)) as unknown as [{ n: string }];
    const [payer] = p.createdByUserId ? await tx.select({ email: users.email }).from(users).where(eq(users.id, p.createdByUserId)) : [];
    await tx.insert(invoices).values({ number: `RM-${new Date().getUTCFullYear()}-${n.padStart(6, "0")}`, organizationId: p.organizationId, paymentId: p.id, currency: p.currency, amountMinor: p.amountMinor, lines: [{ description: line, amountMinor: p.amountMinor }], billTo: { organization: org?.name ?? "", email: payer?.email ?? "" } });
    await this.tell(tx, p.createdByUserId, p.organizationId, "billing.subscription", "Payment received — ResearchMate", `Thank you. We received ${formatMoney(p.amountMinor, p.currency)} for: ${line}. Your invoice is in Settings → Billing.`, `payment:${p.id}`);
  }

  /** Paid periods stack: renewing early extends from the current end, not from today. */
  private async extendPlan(tx: DbOrTx, p: Payment): Promise<Date> {
    await tx.execute(sql`select id from organizations where id = ${p.organizationId} for update`);
    const [live] = await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, p.organizationId), inArray(subscriptions.status, ["active", "trialing", "past_due"])));
    const now = new Date();
    if (live && live.planId === p.planId && live.currentPeriodEnd) {
      const end = addInterval(live.currentPeriodEnd > now ? live.currentPeriodEnd : now, p.interval!);
      await tx.update(subscriptions).set({ status: "active", currentPeriodEnd: end, cancelAtPeriodEnd: false, provider: p.provider, providerReference: p.reference, updatedAt: now }).where(eq(subscriptions.id, live.id));
      return end;
    }
    if (live) await tx.update(subscriptions).set({ status: "canceled", updatedAt: now }).where(eq(subscriptions.id, live.id));
    const end = addInterval(now, p.interval!);
    await tx.insert(subscriptions).values({ organizationId: p.organizationId, planId: p.planId!, status: "active", currentPeriodStart: now, currentPeriodEnd: end, provider: p.provider, providerReference: p.reference, metadata: { paymentId: p.id } });
    return end;
  }

  private async removeCredit(tx: DbOrTx, p: Payment, refundMinor: number, why: string) {
    const micros = Math.floor((p.creditMicros! * refundMinor) / p.amountMinor);
    if (micros <= 0) return;
    await this.ledger.addCredit(tx, { organizationId: p.organizationId, amountMicros: -micros, kind: "refund", paymentId: p.id, description: `Credit removed (${why}, ${formatMoney(refundMinor, p.currency)})`, idempotencyKey: `${why}:${p.id}:${p.refundedMinor}:${refundMinor}` });
  }

  // ----- Refunds -----------------------------------------------------------

  /**
   * Refunds (platform administrators). For credit purchases only unspent
   * credit can be refunded; it is removed from the balance immediately so it
   * can't be spent while the provider processes the refund.
   */
  async refund(adminUserId: string, paymentId: string, amountMinor: number, reason: string) {
    if (!reason.trim()) throw new AppError("VALIDATION", "Give a reason for the refund.");
    const [p] = await this.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!p || !["succeeded", "partially_refunded"].includes(p.status)) throw new AppError("CONFLICT", "Only completed payments can be refunded.");
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > p.amountMinor - p.refundedMinor) throw new AppError("VALIDATION", `Refund between ${formatMoney(1, p.currency)} and ${formatMoney(p.amountMinor - p.refundedMinor, p.currency)}.`);
    if (p.kind === "credits") {
      const need = Math.floor((p.creditMicros! * amountMinor) / p.amountMinor);
      const b = await this.ledger.balance(p.organizationId);
      if (b.creditMicros < need) throw new AppError("VALIDATION", `Only unspent credit can be refunded: ${formatUsd(Math.max(0, b.creditMicros))} is left of the ${formatUsd(need)} this refund would return.`);
    }
    const r = await this.provider(p.provider).refund({ reference: p.reference, providerReference: p.providerReference, details: p.details }, amountMinor, p.currency, reason);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(refunds).values({ paymentId, amountMinor, reason: reason.slice(0, 500), status: r.status, providerReference: r.providerReference, requestedByUserId: adminUserId }).returning();
      if (r.status === "failed") return row!;
      const [cur] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
      const refunded = cur!.refundedMinor + amountMinor;
      if (cur!.kind === "credits") await this.removeCredit(tx, cur!, amountMinor, `refund-${row!.id}`);
      await tx.update(payments).set({ refundedMinor: refunded, status: refunded >= cur!.amountMinor ? "refunded" : "partially_refunded", updatedAt: new Date() }).where(eq(payments.id, paymentId));
      const [{ n }] = (await tx.execute<{ n: string }>(sql`select nextval('invoice_number_seq')::text as n`)) as unknown as [{ n: string }];
      await tx.insert(invoices).values({ number: `RM-${new Date().getUTCFullYear()}-${n.padStart(6, "0")}`, kind: "credit_note", organizationId: cur!.organizationId, paymentId, currency: cur!.currency, amountMinor: -amountMinor, lines: [{ description: `Refund: ${reason.slice(0, 200)}`, amountMinor: -amountMinor }] });
      return row!;
    });
  }

  // ----- History, invoices, subscription -----------------------------------

  async history(actorUserId: string, organizationId: string) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    const [list, inv] = await Promise.all([
      this.db.select().from(payments).where(eq(payments.organizationId, organizationId)).orderBy(desc(payments.createdAt)).limit(100),
      this.db.select().from(invoices).where(eq(invoices.organizationId, organizationId)).orderBy(desc(invoices.issuedAt)),
    ]);
    return { payments: list, invoices: inv };
  }

  async invoice(actorUserId: string, invoiceId: string) {
    const [i] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!i) throw new AppError("NOT_FOUND", "Invoice not found.");
    await requireOrgPermission(this.db, actorUserId, i.organizationId, "org.billing.manage").catch(() => {
      throw new AppError("NOT_FOUND", "Invoice not found.");
    });
    const [p] = await this.db.select().from(payments).where(eq(payments.id, i.paymentId));
    return { invoice: i, payment: p! };
  }

  async subscription(organizationId: string) {
    const [s] = await this.db
      .select({ s: subscriptions, planName: plans.name, planKey: plans.key })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.status, ["active", "trialing", "past_due"])));
    return s ?? null;
  }

  async setCancelAtPeriodEnd(actorUserId: string, organizationId: string, cancel: boolean) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.billing.manage");
    const s = await this.subscription(organizationId);
    if (!s?.s.currentPeriodEnd) throw new AppError("VALIDATION", "There is no paid period to cancel.");
    await this.db.update(subscriptions).set({ cancelAtPeriodEnd: cancel, updatedAt: new Date() }).where(eq(subscriptions.id, s.s.id));
  }

  /**
   * Scheduled: reminds before a paid period ends, marks it past due when it
   * ends, and after the grace period moves the organization to the default
   * plan. Nothing is deleted on downgrade; over-limit content becomes
   * read-only (the documented downgrade policy).
   */
  async runRenewals(now = new Date()) {
    const grace = (this.deps.graceDays ?? 3) * DAY;
    const live = await this.db
      .select({ s: subscriptions, planName: plans.name, owner: organizations.ownerUserId })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(and(inArray(subscriptions.status, ["active", "past_due"]), sql`${subscriptions.currentPeriodEnd} is not null`, isNull(organizations.deletedAt)));
    const [def] = await this.db.select().from(plans).where(eq(plans.isDefault, true));
    let reminded = 0;
    let pastDue = 0;
    let expired = 0;
    for (const { s, planName, owner } of live) {
      const end = s.currentPeriodEnd!;
      if (end.getTime() + grace < now.getTime() || (s.cancelAtPeriodEnd && end < now)) {
        await this.db.transaction(async (tx) => {
          await tx.update(subscriptions).set({ status: "expired", updatedAt: now }).where(eq(subscriptions.id, s.id));
          if (def) await tx.insert(subscriptions).values({ organizationId: s.organizationId, planId: def.id, status: "active", metadata: { after: s.id } });
        });
        expired++;
        await this.tell(this.db, owner, s.organizationId, "billing.subscription", `Your ${planName} plan has ended`, `Your ResearchMate ${planName} plan ended on ${end.toISOString().slice(0, 10)}. Your workspace is now on the ${def?.name ?? "free"} plan. Nothing has been deleted; anything above the new plan's limits is read-only until you renew.`, `plan-ended:${s.id}`);
      } else if (end < now && s.status === "active") {
        await this.db.update(subscriptions).set({ status: "past_due", updatedAt: now }).where(eq(subscriptions.id, s.id));
        pastDue++;
        await this.tell(this.db, owner, s.organizationId, "billing.subscription", `Renew your ${planName} plan`, `Your ResearchMate ${planName} period ended on ${end.toISOString().slice(0, 10)}. Renew within ${this.deps.graceDays ?? 3} days to keep your plan.`, `past-due:${s.id}:${end.toISOString()}`);
      } else if (!s.cancelAtPeriodEnd && end.getTime() - now.getTime() < 7 * DAY && end > now && s.metadata.remindedFor !== end.toISOString()) {
        await this.db.update(subscriptions).set({ metadata: { ...s.metadata, remindedFor: end.toISOString() }, updatedAt: now }).where(eq(subscriptions.id, s.id));
        reminded++;
        await this.tell(this.db, owner, s.organizationId, "billing.subscription", `Your ${planName} plan renews soon`, `Your ResearchMate ${planName} period ends on ${end.toISOString().slice(0, 10)}. Renew from Settings → Billing (mobile money and cards).`, `renew-soon:${s.id}:${end.toISOString()}`);
      }
    }
    // Abandoned checkouts: re-check anything pending for more than an hour, then give up after a day.
    const stale = await this.db.select({ id: payments.id, createdAt: payments.createdAt }).from(payments).where(and(eq(payments.status, "pending"), lt(payments.createdAt, new Date(now.getTime() - 3600_000)))).limit(100);
    for (const p of stale) {
      try {
        const r = await this.reconcile(p.id);
        if (r.status === "pending" && p.createdAt.getTime() < now.getTime() - DAY) await this.db.update(payments).set({ status: "cancelled", updatedAt: now }).where(and(eq(payments.id, p.id), eq(payments.status, "pending")));
      } catch (err) {
        logger.warn("billing.reconcile_failed", { paymentId: p.id, error: String(err) });
      }
    }
    return { reminded, pastDue, expired, rechecked: stale.length };
  }

  async adminPayments(limit = 100) {
    return this.db.select({ p: payments, org: organizations.name }).from(payments).innerJoin(organizations, eq(organizations.id, payments.organizationId)).where(or(eq(payments.status, "succeeded"), eq(payments.status, "partially_refunded"), eq(payments.status, "refunded"), eq(payments.status, "pending"), eq(payments.status, "failed"))).orderBy(desc(payments.createdAt)).limit(limit);
  }
}
