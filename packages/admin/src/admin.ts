import { randomUUID } from "node:crypto";
import {
  apifyActors,
  auditLogs,
  creditLedgerEntries,
  type Database,
  type EntitlementValue,
  FEATURES,
  type FeatureKey,
  invoices,
  organizationEntitlementOverrides,
  organizationMembers,
  organizations,
  payments,
  plans,
  researchProjects,
  roles,
  securityEvents,
  sessions,
  subscriptions,
  supportTickets,
  twoFactorRecoveryCodes,
  twoFactorSettings,
  userProfiles,
  users,
} from "@researchmate/database";
import { getLimitStatus, lockOrganization } from "@researchmate/entitlements";
import { AppError } from "@researchmate/shared";
import { notify, recordAudit } from "@researchmate/tenancy";
import { aliasedTable, and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { requirePlatformAdmin } from "./guard";
import { likePattern, pageOf, parseEntitlementValue } from "./values";

const LIVE = ["active", "trialing", "past_due"] as const;
const DAY = 86_400_000;

function reasonOf(reason: string | undefined, what = "a reason"): string {
  const r = (reason ?? "").trim();
  if (r.length < 3) throw new AppError("VALIDATION", `Give ${what} (it is kept in the audit log).`);
  return r.slice(0, 500);
}

export type UserFilter = "all" | "active" | "disabled" | "unverified" | "admins";
export type SubscriptionFilter = "live" | "paid" | "complimentary" | "past_due" | "expiring" | "ended" | "all";

/**
 * Platform administration (§28 "Administration"): users, organizations,
 * subscriptions, entitlements, credit, audit records and the integration
 * allowlist. Every method re-checks that the actor is an active platform
 * administrator and records what it changed in the audit log.
 */
export class AdminService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------------ overview

  async overview(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const since30 = new Date(Date.now() - 30 * DAY);
    const since7 = new Date(Date.now() - 7 * DAY);
    const [u] = await this.db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${users.status} = 'active')::int`,
        disabled: sql<number>`count(*) filter (where ${users.status} = 'disabled')::int`,
        unverified: sql<number>`count(*) filter (where ${users.emailVerifiedAt} is null and ${users.status} = 'active')::int`,
        new7: sql<number>`count(*) filter (where ${users.createdAt} >= ${since7.toISOString()}::timestamptz)::int`,
        new30: sql<number>`count(*) filter (where ${users.createdAt} >= ${since30.toISOString()}::timestamptz)::int`,
        active30: sql<number>`count(*) filter (where ${users.lastLoginAt} >= ${since30.toISOString()}::timestamptz)::int`,
        admins: sql<number>`count(*) filter (where ${users.isPlatformAdmin})::int`,
      })
      .from(users)
      .where(sql`${users.email} not like '%@deleted.invalid'`);
    const [o] = await this.db
      .select({
        total: count(),
        team: sql<number>`count(*) filter (where ${organizations.kind} = 'team')::int`,
        scheduled: sql<number>`count(*) filter (where ${organizations.deletedAt} is not null)::int`,
      })
      .from(organizations);
    const byPlan = await this.db
      .select({ planId: plans.id, plan: plans.name, priceMinor: plans.priceMinor, currency: plans.currency, status: subscriptions.status, n: count() })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(and(inArray(subscriptions.status, [...LIVE]), isNull(organizations.deletedAt)))
      .groupBy(plans.id, plans.name, plans.priceMinor, plans.currency, plans.sortOrder, subscriptions.status)
      .orderBy(asc(plans.sortOrder));
    const revenue = await this.db
      .select({ currency: payments.currency, gross: sql<number>`sum(${payments.amountMinor})::bigint`, refunded: sql<number>`sum(${payments.refundedMinor})::bigint`, n: count() })
      .from(payments)
      .where(and(inArray(payments.status, ["succeeded", "partially_refunded", "refunded"]), gte(payments.createdAt, since30)))
      .groupBy(payments.currency);
    const [pay] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${payments.status} = 'pending')::int`,
        failed30: sql<number>`count(*) filter (where ${payments.status} = 'failed' and ${payments.createdAt} >= ${since30.toISOString()}::timestamptz)::int`,
      })
      .from(payments);
    const [ai] = await this.db
      .select({ micros: sql<number>`coalesce(-sum(${creditLedgerEntries.amountMicros}), 0)::bigint` })
      .from(creditLedgerEntries)
      .where(and(eq(creditLedgerEntries.kind, "usage"), gte(creditLedgerEntries.createdAt, since30)));
    const [t] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${supportTickets.status} = 'open')::int`,
        pending: sql<number>`count(*) filter (where ${supportTickets.status} = 'pending')::int`,
        unassigned: sql<number>`count(*) filter (where ${supportTickets.status} = 'open' and ${supportTickets.assignedToUserId} is null)::int`,
      })
      .from(supportTickets);
    const expiring = await this.db
      .select({ n: count() })
      .from(subscriptions)
      .where(and(inArray(subscriptions.status, [...LIVE]), isNotNull(subscriptions.currentPeriodEnd), sql`${subscriptions.currentPeriodEnd} < now() + interval '14 days'`));
    const recentUsers = await this.db
      .select({ id: users.id, email: users.email, name: userProfiles.displayName, createdAt: users.createdAt, verified: isNotNull(users.emailVerifiedAt) })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(sql`${users.email} not like '%@deleted.invalid'`)
      .orderBy(desc(users.createdAt))
      .limit(8);
    return {
      users: u!,
      organizations: o!,
      subscriptions: byPlan.map((r) => ({ ...r, n: Number(r.n) })),
      revenue30: revenue.map((r) => ({ currency: r.currency, gross: Number(r.gross), refunded: Number(r.refunded), net: Number(r.gross) - Number(r.refunded), payments: Number(r.n) })),
      payments: pay!,
      aiSpend30Micros: Number(ai?.micros ?? 0),
      enquiries: t!,
      expiringSoon: Number(expiring[0]?.n ?? 0),
      recentUsers,
    };
  }

  // --------------------------------------------------------------------- users

  async listUsers(actorUserId: string, opts: { q?: string; filter?: UserFilter; page?: number } = {}) {
    await requirePlatformAdmin(this.db, actorUserId);
    const { limit, offset, page } = pageOf(opts.page);
    const where: (SQL | undefined)[] = [sql`${users.email} not like '%@deleted.invalid'`];
    if (opts.q?.trim()) where.push(or(ilike(users.email, likePattern(opts.q)), ilike(userProfiles.displayName, likePattern(opts.q)), ilike(userProfiles.institution, likePattern(opts.q))));
    switch (opts.filter) {
      case "active": where.push(eq(users.status, "active")); break;
      case "disabled": where.push(eq(users.status, "disabled")); break;
      case "unverified": where.push(isNull(users.emailVerifiedAt)); break;
      case "admins": where.push(eq(users.isPlatformAdmin, true)); break;
    }
    const cond = and(...where);
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: userProfiles.displayName,
        institution: userProfiles.institution,
        status: users.status,
        isPlatformAdmin: users.isPlatformAdmin,
        emailVerifiedAt: users.emailVerifiedAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        twoFactor: sql<boolean>`exists (select 1 from two_factor_settings tf where tf.user_id = ${users.id} and tf.enabled_at is not null)`,
        organizations: sql<number>`(select count(*)::int from organization_members m where m.user_id = ${users.id})`,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(cond)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ n }] = (await this.db.select({ n: count() }).from(users).leftJoin(userProfiles, eq(userProfiles.userId, users.id)).where(cond)) as [{ n: number }];
    return { rows, total: Number(n), page };
  }

  async getUser(actorUserId: string, userId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [u] = await this.db
      .select({ user: users, profile: userProfiles })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, userId));
    if (!u) throw new AppError("NOT_FOUND", "No such user.");
    const [tf] = await this.db.select({ enabledAt: twoFactorSettings.enabledAt }).from(twoFactorSettings).where(eq(twoFactorSettings.userId, userId));
    const memberships = await this.db
      .select({ id: organizations.id, name: organizations.name, kind: organizations.kind, role: roles.name, roleKey: organizationMembers.roleKey, isOwner: sql<boolean>`${organizations.ownerUserId} = ${userId}`, deletedAt: organizations.deletedAt, plan: plans.name, subscriptionStatus: subscriptions.status })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(roles, eq(roles.key, organizationMembers.roleKey))
      .leftJoin(subscriptions, and(eq(subscriptions.organizationId, organizations.id), inArray(subscriptions.status, [...LIVE])))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.name));
    const activeSessions = await this.db
      .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(20);
    const events = await this.db.select().from(securityEvents).where(eq(securityEvents.userId, userId)).orderBy(desc(securityEvents.createdAt)).limit(25);
    const audit = await this.auditFor({ targetType: "user", targetId: userId }, 25);
    const tickets = await this.db
      .select({ id: supportTickets.id, reference: supportTickets.reference, subject: supportTickets.subject, status: supportTickets.status, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(or(eq(supportTickets.userId, userId), eq(supportTickets.requesterEmail, u.user.email)))
      .orderBy(desc(supportTickets.createdAt))
      .limit(20);
    const { passwordHash: _omit, ...safeUser } = u.user;
    return { user: safeUser, profile: u.profile, twoFactorEnabledAt: tf?.enabledAt ?? null, memberships, sessions: activeSessions, events, audit, tickets };
  }

  async setUserStatus(actorUserId: string, userId: string, status: "active" | "disabled", reason?: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(reason);
    if (userId === actorUserId) throw new AppError("VALIDATION", "You can't disable your own account.");
    return this.db.transaction(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!u) throw new AppError("NOT_FOUND", "No such user.");
      if (u.email.endsWith("@deleted.invalid")) throw new AppError("VALIDATION", "This account was deleted by its owner and can't be changed.");
      if (u.status === status) return { changed: false, revokedSessions: 0 };
      await tx.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
      let revoked = 0;
      if (status === "disabled") {
        const r = await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
        revoked = r.length;
      }
      await tx.insert(securityEvents).values({ userId, type: status === "disabled" ? "account.disabled_by_admin" : "account.enabled_by_admin", metadata: { by: actorUserId } });
      await recordAudit(tx, { actorUserId, action: status === "disabled" ? "admin.user.disabled" : "admin.user.enabled", targetType: "user", targetId: userId, metadata: { reason: why, email: u.email, revokedSessions: revoked } });
      return { changed: true, revokedSessions: revoked };
    });
  }

  async verifyEmail(actorUserId: string, userId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [u] = await this.db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt))).returning({ email: users.email });
    if (!u) throw new AppError("VALIDATION", "That email address is already verified (or the user doesn't exist).");
    await recordAudit(this.db, { actorUserId, action: "admin.user.email_verified", targetType: "user", targetId: userId, metadata: { email: u.email } });
  }

  async setPlatformAdmin(actorUserId: string, userId: string, grant: boolean, reason?: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(reason);
    if (userId === actorUserId && !grant) throw new AppError("VALIDATION", "You can't remove your own administrator role. Ask another administrator.");
    await this.db.transaction(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!u) throw new AppError("NOT_FOUND", "No such user.");
      if (grant && (u.status !== "active" || !u.emailVerifiedAt)) throw new AppError("VALIDATION", "Only active accounts with a verified email address can be made administrators.");
      if (u.isPlatformAdmin === grant) return;
      await tx.update(users).set({ isPlatformAdmin: grant, updatedAt: new Date() }).where(eq(users.id, userId));
      await tx.insert(securityEvents).values({ userId, type: grant ? "admin.granted" : "admin.revoked", metadata: { by: actorUserId } });
      await recordAudit(tx, { actorUserId, action: grant ? "admin.user.admin_granted" : "admin.user.admin_revoked", targetType: "user", targetId: userId, metadata: { reason: why, email: u.email } });
      await notify(tx, { userIds: [userId], kind: "security.alert", title: grant ? "You are now a platform administrator" : "Your platform administrator role was removed", body: grant ? "You can now manage users, plans and billing for the whole platform. If you didn't expect this, contact the other administrators." : "You no longer have access to platform administration.", link: "/app/settings/security" });
    });
  }

  async revokeSessions(actorUserId: string, userId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const r = await this.db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
    await this.db.insert(securityEvents).values({ userId, type: "sessions.revoked_by_admin", metadata: { by: actorUserId, count: r.length } });
    await recordAudit(this.db, { actorUserId, action: "admin.user.sessions_revoked", targetType: "user", targetId: userId, metadata: { count: r.length } });
    return r.length;
  }

  /** For a user who lost both their authenticator and recovery codes (after verifying who they are). */
  async resetTwoFactor(actorUserId: string, userId: string, reason?: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(reason, "a reason, e.g. how you confirmed who they are");
    await this.db.transaction(async (tx) => {
      const [tf] = await tx.select().from(twoFactorSettings).where(eq(twoFactorSettings.userId, userId));
      if (!tf?.enabledAt) throw new AppError("VALIDATION", "Two-factor authentication isn't turned on for this user.");
      await tx.delete(twoFactorSettings).where(eq(twoFactorSettings.userId, userId));
      await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await tx.insert(securityEvents).values({ userId, type: "two_factor.reset_by_admin", metadata: { by: actorUserId } });
      await recordAudit(tx, { actorUserId, action: "admin.user.two_factor_reset", targetType: "user", targetId: userId, metadata: { reason: why } });
      await notify(tx, { userIds: [userId], kind: "security.alert", title: "Two-factor authentication was reset", body: "A ResearchMate administrator turned off two-factor authentication for your account at your request, and signed out all your sessions. Sign in and turn it on again from Settings → Security. If you didn't ask for this, contact support immediately.", link: "/app/settings/security" });
    });
  }

  /** Records an administrator-initiated password reset email (the email itself is sent by the auth service). */
  async recordPasswordResetSent(actorUserId: string, userId: string) {
    const admin = await requirePlatformAdmin(this.db, actorUserId);
    const [u] = await this.db.select({ email: users.email, status: users.status }).from(users).where(eq(users.id, userId));
    if (!u) throw new AppError("NOT_FOUND", "No such user.");
    if (u.status !== "active") throw new AppError("VALIDATION", "The account is disabled. Enable it first.");
    await recordAudit(this.db, { actorUserId: admin.id, action: "admin.user.password_reset_sent", targetType: "user", targetId: userId });
    return u.email;
  }

  // ------------------------------------------------------------- organizations

  async listOrganizations(actorUserId: string, opts: { q?: string; kind?: "team" | "personal"; planId?: string; deleted?: boolean; page?: number } = {}) {
    await requirePlatformAdmin(this.db, actorUserId);
    const { limit, offset, page } = pageOf(opts.page);
    const owner = aliasedTable(users, "owner");
    const where: (SQL | undefined)[] = [];
    if (opts.q?.trim()) where.push(or(ilike(organizations.name, likePattern(opts.q)), ilike(organizations.slug, likePattern(opts.q)), ilike(owner.email, likePattern(opts.q))));
    if (opts.kind) where.push(eq(organizations.kind, opts.kind));
    if (opts.planId) where.push(eq(subscriptions.planId, opts.planId));
    if (opts.deleted) where.push(isNotNull(organizations.deletedAt));
    const cond = and(...where);
    const base = this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        kind: organizations.kind,
        createdAt: organizations.createdAt,
        deletedAt: organizations.deletedAt,
        ownerId: owner.id,
        ownerEmail: owner.email,
        plan: plans.name,
        planKey: plans.key,
        status: subscriptions.status,
        periodEnd: subscriptions.currentPeriodEnd,
        members: sql<number>`(select count(*)::int from organization_members m where m.organization_id = ${organizations.id})`,
        projects: sql<number>`(select count(*)::int from research_projects p where p.organization_id = ${organizations.id})`,
      })
      .from(organizations)
      .innerJoin(owner, eq(owner.id, organizations.ownerUserId))
      .leftJoin(subscriptions, and(eq(subscriptions.organizationId, organizations.id), inArray(subscriptions.status, [...LIVE])))
      .leftJoin(plans, eq(plans.id, subscriptions.planId));
    const rows = await base.where(cond).orderBy(desc(organizations.createdAt)).limit(limit).offset(offset);
    const [{ n }] = (await this.db
      .select({ n: count() })
      .from(organizations)
      .innerJoin(owner, eq(owner.id, organizations.ownerUserId))
      .leftJoin(subscriptions, and(eq(subscriptions.organizationId, organizations.id), inArray(subscriptions.status, [...LIVE])))
      .where(cond)) as [{ n: number }];
    return { rows, total: Number(n), page };
  }

  async getOrganization(actorUserId: string, organizationId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, organizationId));
    if (!org) throw new AppError("NOT_FOUND", "No such organization.");
    const [owner] = await this.db.select({ id: users.id, email: users.email, name: userProfiles.displayName }).from(users).leftJoin(userProfiles, eq(userProfiles.userId, users.id)).where(eq(users.id, org.ownerUserId));
    const members = await this.db
      .select({ id: users.id, email: users.email, name: userProfiles.displayName, role: roles.name, joinedAt: organizationMembers.joinedAt, status: users.status })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .innerJoin(roles, eq(roles.key, organizationMembers.roleKey))
      .where(eq(organizationMembers.organizationId, organizationId))
      .orderBy(desc(roles.rank), asc(users.email));
    const subs = await this.db
      .select({ s: subscriptions, plan: plans.name, planKey: plans.key })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.organizationId, organizationId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(30);
    const setBy = aliasedTable(users, "set_by");
    const overrides = await this.db
      .select({ o: organizationEntitlementOverrides, setBy: setBy.email })
      .from(organizationEntitlementOverrides)
      .leftJoin(setBy, eq(setBy.id, organizationEntitlementOverrides.setByUserId))
      .where(eq(organizationEntitlementOverrides.organizationId, organizationId))
      .orderBy(asc(organizationEntitlementOverrides.featureKey));
    const limits = await getLimitStatus(this.db, organizationId);
    const [credit] = await this.db
      .select({ micros: sql<number>`coalesce(sum(${creditLedgerEntries.amountMicros}), 0)::bigint` })
      .from(creditLedgerEntries)
      .where(and(eq(creditLedgerEntries.organizationId, organizationId), eq(creditLedgerEntries.pool, "credit")));
    const ledger = await this.db.select().from(creditLedgerEntries).where(and(eq(creditLedgerEntries.organizationId, organizationId), ne(creditLedgerEntries.kind, "usage"))).orderBy(desc(creditLedgerEntries.createdAt)).limit(20);
    const pays = await this.db.select().from(payments).where(eq(payments.organizationId, organizationId)).orderBy(desc(payments.createdAt)).limit(20);
    const [inv] = await this.db.select({ n: count() }).from(invoices).where(eq(invoices.organizationId, organizationId));
    const [proj] = await this.db.select({ n: count() }).from(researchProjects).where(eq(researchProjects.organizationId, organizationId));
    const audit = await this.auditFor({ organizationId }, 30);
    return { org, owner: owner ?? null, members, subscriptions: subs, live: subs.find((x) => (LIVE as readonly string[]).includes(x.s.status)) ?? null, overrides, limits, creditMicros: Number(credit?.micros ?? 0), ledger, payments: pays, invoiceCount: Number(inv?.n ?? 0), projectCount: Number(proj?.n ?? 0), audit };
  }

  /**
   * Puts an organization on a plan without a payment: complimentary access,
   * institutional deals, or correcting a mistake. With `periodEnd` the plan
   * ends then (and the renewal job moves the organization back to the default
   * plan); without it, the plan continues until changed.
   */
  async assignPlan(actorUserId: string, organizationId: string, input: { planId: string; periodEnd: Date | null; reason?: string }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(input.reason);
    if (input.periodEnd && input.periodEnd.getTime() <= Date.now()) throw new AppError("VALIDATION", "The end date must be in the future.");
    return this.db.transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
      if (!org) throw new AppError("NOT_FOUND", "No such organization.");
      const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId));
      if (!plan) throw new AppError("NOT_FOUND", "No such plan.");
      const [live] = await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.status, [...LIVE])));
      const now = new Date();
      if (live) await tx.update(subscriptions).set({ status: "canceled", updatedAt: now, metadata: { ...live.metadata, replacedBy: "admin", reason: why } }).where(eq(subscriptions.id, live.id));
      const [sub] = await tx
        .insert(subscriptions)
        .values({ organizationId, planId: plan.id, status: "active", currentPeriodStart: now, currentPeriodEnd: input.periodEnd, provider: "manual", metadata: { assignedBy: actorUserId, reason: why, ...(live ? { after: live.id } : {}) } })
        .returning();
      await recordAudit(tx, { organizationId, actorUserId, action: "admin.subscription.assigned", targetType: "subscription", targetId: sub!.id, metadata: { plan: plan.key, previousPlanId: live?.planId ?? null, periodEnd: input.periodEnd?.toISOString() ?? null, reason: why } });
      await notify(tx, { userIds: [org.ownerUserId], organizationId, kind: "billing.subscription", title: `Your workspace is now on the ${plan.name} plan`, body: input.periodEnd ? `“${org.name}” is on the ${plan.name} plan until ${input.periodEnd.toISOString().slice(0, 10)}.` : `“${org.name}” is on the ${plan.name} plan.`, link: "/app/settings/billing" });
      return sub!;
    });
  }

  /** Changes when the current period ends (null = no end), e.g. to extend a trial or a paid period. */
  async setPeriodEnd(actorUserId: string, organizationId: string, periodEnd: Date | null, reason?: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(reason);
    if (periodEnd && periodEnd.getTime() <= Date.now()) throw new AppError("VALIDATION", "The end date must be in the future. To end a plan now, cancel it.");
    await this.db.transaction(async (tx) => {
      const [live] = await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.status, [...LIVE]))).for("update");
      if (!live) throw new AppError("VALIDATION", "This organization has no current subscription. Assign a plan instead.");
      await tx.update(subscriptions).set({ currentPeriodEnd: periodEnd, status: live.status === "past_due" ? "active" : live.status, cancelAtPeriodEnd: false, updatedAt: new Date() }).where(eq(subscriptions.id, live.id));
      await recordAudit(tx, { organizationId, actorUserId, action: "admin.subscription.period_changed", targetType: "subscription", targetId: live.id, metadata: { from: live.currentPeriodEnd?.toISOString() ?? null, to: periodEnd?.toISOString() ?? null, reason: why } });
    });
  }

  /** Ends the current plan now (moving to the default plan) or at the end of the paid period. */
  async cancelSubscription(actorUserId: string, organizationId: string, input: { immediately: boolean; reason?: string }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(input.reason);
    await this.db.transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      const [live] = await tx.select({ s: subscriptions, plan: plans }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.status, [...LIVE])));
      if (!live) throw new AppError("VALIDATION", "This organization has no current subscription.");
      const [def] = await tx.select().from(plans).where(eq(plans.isDefault, true));
      if (live.plan.isDefault) throw new AppError("VALIDATION", "The organization is already on the default plan.");
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
      if (input.immediately) {
        await tx.update(subscriptions).set({ status: "canceled", updatedAt: new Date(), metadata: { ...live.s.metadata, canceledBy: actorUserId, reason: why } }).where(eq(subscriptions.id, live.s.id));
        if (def) await tx.insert(subscriptions).values({ organizationId, planId: def.id, status: "active", metadata: { after: live.s.id } });
      } else {
        if (!live.s.currentPeriodEnd) throw new AppError("VALIDATION", "This plan has no end date; cancel it immediately or set an end date first.");
        await tx.update(subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: new Date() }).where(eq(subscriptions.id, live.s.id));
      }
      await recordAudit(tx, { organizationId, actorUserId, action: input.immediately ? "admin.subscription.canceled" : "admin.subscription.cancel_at_period_end", targetType: "subscription", targetId: live.s.id, metadata: { plan: live.plan.key, reason: why } });
      if (org)
        await notify(tx, {
          userIds: [org.ownerUserId],
          organizationId,
          kind: "billing.subscription",
          title: input.immediately ? `Your ${live.plan.name} plan has ended` : `Your ${live.plan.name} plan will end on ${live.s.currentPeriodEnd!.toISOString().slice(0, 10)}`,
          body: input.immediately ? `“${org.name}” is now on the ${def?.name ?? "free"} plan. Nothing has been deleted; anything above the new plan's limits is read-only.` : `“${org.name}” keeps the ${live.plan.name} plan until then, then moves to the ${def?.name ?? "free"} plan.`,
          link: "/app/settings/billing",
        });
    });
  }

  async setOverride(actorUserId: string, organizationId: string, input: { featureKey: string; value: string; reason?: string; expiresAt: Date | null }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(input.reason);
    const value: EntitlementValue = parseEntitlementValue(input.featureKey, input.value);
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new AppError("VALIDATION", "The expiry date must be in the future.");
    const [org] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId));
    if (!org) throw new AppError("NOT_FOUND", "No such organization.");
    await this.db
      .insert(organizationEntitlementOverrides)
      .values({ organizationId, featureKey: input.featureKey, value, reason: why, setByUserId: actorUserId, expiresAt: input.expiresAt })
      .onConflictDoUpdate({ target: [organizationEntitlementOverrides.organizationId, organizationEntitlementOverrides.featureKey], set: { value, reason: why, setByUserId: actorUserId, expiresAt: input.expiresAt, createdAt: new Date() } });
    await recordAudit(this.db, { organizationId, actorUserId, action: "admin.entitlement.override_set", targetType: "organization", targetId: organizationId, metadata: { featureKey: input.featureKey, value, expiresAt: input.expiresAt?.toISOString() ?? null, reason: why } });
  }

  async removeOverride(actorUserId: string, organizationId: string, featureKey: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const r = await this.db.delete(organizationEntitlementOverrides).where(and(eq(organizationEntitlementOverrides.organizationId, organizationId), eq(organizationEntitlementOverrides.featureKey, featureKey))).returning();
    if (!r.length) throw new AppError("NOT_FOUND", "No such override.");
    await recordAudit(this.db, { organizationId, actorUserId, action: "admin.entitlement.override_removed", targetType: "organization", targetId: organizationId, metadata: { featureKey, value: r[0]!.value } });
  }

  /** Adds (positive) or removes (negative) prepaid AI credit, in US dollars. */
  async adjustCredit(actorUserId: string, organizationId: string, input: { usd: number; reason?: string }) {
    await requirePlatformAdmin(this.db, actorUserId);
    const why = reasonOf(input.reason);
    const micros = Math.round(input.usd * 1_000_000);
    if (!Number.isFinite(input.usd) || micros === 0 || Math.abs(input.usd) > 100_000) throw new AppError("VALIDATION", "Enter a non-zero amount in US dollars (at most 100,000).");
    const [org] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId));
    if (!org) throw new AppError("NOT_FOUND", "No such organization.");
    const id = randomUUID();
    await this.db.insert(creditLedgerEntries).values({ organizationId, kind: "adjustment", pool: "credit", amountMicros: micros, description: `Adjustment by an administrator: ${why}`.slice(0, 300), idempotencyKey: `admin-adjust:${id}`, createdByUserId: actorUserId });
    await recordAudit(this.db, { organizationId, actorUserId, action: "admin.credit.adjusted", targetType: "organization", targetId: organizationId, metadata: { micros, reason: why } });
  }

  /** Cancels a scheduled deletion (any owner's), as long as the purge hasn't started. */
  async restoreOrganization(actorUserId: string, organizationId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [row] = await this.db
      .update(organizations)
      .set({ deletedAt: null, purgeAfter: null, updatedAt: new Date() })
      .where(and(eq(organizations.id, organizationId), isNotNull(organizations.deletedAt), isNull(organizations.purgeStartedAt)))
      .returning();
    if (!row) throw new AppError("VALIDATION", "This organization isn't scheduled for deletion, or its purge has already started.");
    await recordAudit(this.db, { organizationId, actorUserId, action: "admin.organization.restored", targetType: "organization", targetId: organizationId });
    await notify(this.db, { userIds: [row.ownerUserId], organizationId, kind: "security.alert", title: `“${row.name}” was restored`, body: "A ResearchMate administrator cancelled the scheduled deletion of this workspace. Everything in it is available again.", link: "/app/settings/organization" });
  }

  // ------------------------------------------------------------- subscriptions

  async listSubscriptions(actorUserId: string, opts: { filter?: SubscriptionFilter; planId?: string; page?: number } = {}) {
    await requirePlatformAdmin(this.db, actorUserId);
    const { limit, offset, page } = pageOf(opts.page);
    const where: (SQL | undefined)[] = [];
    switch (opts.filter ?? "live") {
      case "live": where.push(inArray(subscriptions.status, [...LIVE])); break;
      case "paid": where.push(inArray(subscriptions.status, [...LIVE]), ne(subscriptions.provider, "manual")); break;
      case "complimentary": where.push(inArray(subscriptions.status, [...LIVE]), eq(subscriptions.provider, "manual"), eq(plans.isDefault, false)); break;
      case "past_due": where.push(eq(subscriptions.status, "past_due")); break;
      case "expiring": where.push(inArray(subscriptions.status, [...LIVE]), isNotNull(subscriptions.currentPeriodEnd), sql`${subscriptions.currentPeriodEnd} < now() + interval '14 days'`); break;
      case "ended": where.push(inArray(subscriptions.status, ["canceled", "expired"])); break;
    }
    if (opts.planId) where.push(eq(subscriptions.planId, opts.planId));
    const cond = and(...where);
    const owner = aliasedTable(users, "owner");
    const rows = await this.db
      .select({ s: subscriptions, plan: plans.name, isDefaultPlan: plans.isDefault, org: organizations.name, orgId: organizations.id, ownerEmail: owner.email })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .innerJoin(owner, eq(owner.id, organizations.ownerUserId))
      .where(cond)
      .orderBy(opts.filter === "expiring" ? asc(subscriptions.currentPeriodEnd) : desc(subscriptions.updatedAt))
      .limit(limit)
      .offset(offset);
    const [{ n }] = (await this.db.select({ n: count() }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(cond)) as [{ n: number }];
    return { rows, total: Number(n), page };
  }

  // --------------------------------------------------------------------- audit

  private async auditFor(where: { organizationId?: string; targetType?: string; targetId?: string }, limit: number) {
    const actor = aliasedTable(users, "actor");
    return this.db
      .select({ a: auditLogs, actorEmail: actor.email })
      .from(auditLogs)
      .leftJoin(actor, eq(actor.id, auditLogs.actorUserId))
      .where(and(where.organizationId ? eq(auditLogs.organizationId, where.organizationId) : undefined, where.targetType ? eq(auditLogs.targetType, where.targetType) : undefined, where.targetId ? eq(auditLogs.targetId, where.targetId) : undefined))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  async listAudit(actorUserId: string, opts: { action?: string; actor?: string; organizationId?: string; adminOnly?: boolean; page?: number } = {}) {
    await requirePlatformAdmin(this.db, actorUserId);
    const { limit, offset, page } = pageOf(opts.page);
    const actor = aliasedTable(users, "actor");
    const where: (SQL | undefined)[] = [];
    if (opts.action?.trim()) where.push(ilike(auditLogs.action, `${opts.action.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    if (opts.actor?.trim()) where.push(ilike(actor.email, likePattern(opts.actor)));
    if (opts.organizationId) where.push(eq(auditLogs.organizationId, opts.organizationId));
    if (opts.adminOnly) where.push(ilike(auditLogs.action, "admin.%"));
    const cond = and(...where);
    const rows = await this.db
      .select({ a: auditLogs, actorEmail: actor.email, org: organizations.name })
      .from(auditLogs)
      .leftJoin(actor, eq(actor.id, auditLogs.actorUserId))
      .leftJoin(organizations, eq(organizations.id, auditLogs.organizationId))
      .where(cond)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ n }] = (await this.db.select({ n: count() }).from(auditLogs).leftJoin(actor, eq(actor.id, auditLogs.actorUserId)).where(cond)) as [{ n: number }];
    return { rows, total: Number(n), page };
  }

  // -------------------------------------------------------------- integrations

  async listApifyActors(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    return this.db.select().from(apifyActors).orderBy(asc(apifyActors.name));
  }

  async setApifyActorEnabled(actorUserId: string, actorId: string, enabled: boolean) {
    await requirePlatformAdmin(this.db, actorUserId);
    const [a] = await this.db.update(apifyActors).set({ enabled }).where(eq(apifyActors.id, actorId)).returning();
    if (!a) throw new AppError("NOT_FOUND", "No such Actor.");
    await recordAudit(this.db, { actorUserId, action: enabled ? "admin.apify.actor_enabled" : "admin.apify.actor_disabled", targetType: "apify_actor", targetId: actorId, metadata: { key: a.key, actorId: a.actorId } });
  }

  /** Platform administrators (for assignment pickers). */
  async listAdmins(actorUserId: string) {
    await requirePlatformAdmin(this.db, actorUserId);
    return this.db
      .select({ id: users.id, email: users.email, name: userProfiles.displayName })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(and(eq(users.isPlatformAdmin, true), eq(users.status, "active")))
      .orderBy(asc(users.email));
  }
}

export const FEATURE_LIST = (Object.keys(FEATURES) as FeatureKey[]).map((key) => ({ key, ...FEATURES[key] }));
