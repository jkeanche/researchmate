import { AdminService, formatEntitlementValue, parseEntitlementValue, PlanAdminService, SupportService } from "@researchmate/admin";
import { CapturingMailer } from "@researchmate/auth";
import { PaymentService } from "@researchmate/billing";
import { auditLogs, notifications, plans, pricePoints, sessions, subscriptions, supportTicketMessages, twoFactorSettings, users } from "@researchmate/database";
import { getEntitlements } from "@researchmate/entitlements";
import { AppError } from "@researchmate/shared";
import { scheduleOrganizationDeletion } from "@researchmate/tenancy";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, makeAuth, PASSWORD, testDb } from "./helpers";

const db = testDb();
const admin = new AdminService(db);
const planAdmin = new PlanAdminService(db);
const mailer = new CapturingMailer();
const support = new SupportService({ db, mailer, appUrl: "https://research.test", secret: "test-secret-0123456789abcdef0123456789" });

async function code<T>(p: Promise<T>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

let root: Awaited<ReturnType<typeof createUser>>;
let other: Awaited<ReturnType<typeof createUser>>;

async function makeAdmin() {
  const u = await createUser("Platform Admin");
  await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, u.userId));
  return u;
}

async function lastAudit(action: string) {
  const [a] = await db.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(auditLogs.createdAt);
  return a;
}

beforeAll(async () => {
  root = await makeAdmin();
  other = await createUser("Ordinary Researcher");
});
afterAll(closeTestDb);

describe("entitlement value parsing", () => {
  it("accepts sizes, dollars, unlimited, flags and tiers, and round-trips them", () => {
    expect(parseEntitlementValue("storage.max_bytes", "5 GB")).toBe(5 * 1024 ** 3);
    expect(parseEntitlementValue("storage.max_bytes", "500mb")).toBe(500 * 1024 ** 2);
    expect(parseEntitlementValue("projects.max", "unlimited")).toBeNull();
    expect(parseEntitlementValue("projects.max", "1,000")).toBe(1000);
    expect(parseEntitlementValue("ai.platform.allowance", "12.50")).toBe(12_500_000);
    expect(parseEntitlementValue("finance.budget", "on")).toBe(true);
    expect(parseEntitlementValue("ai.agents", "full")).toBe("full");
    for (const [k, v] of [["storage.max_bytes", 5 * 1024 ** 3], ["files.max_size_bytes", 123], ["projects.max", null], ["ai.platform.allowance", 12_500_000], ["ai.agents", "limited"], ["finance.budget", true]] as const)
      expect(parseEntitlementValue(k, formatEntitlementValue(k, v))).toEqual(v);
  });

  it("rejects values that don't fit the feature", () => {
    for (const [k, v] of [["projects.max", "-1"], ["projects.max", "1.5"], ["ai.agents", "maximum"], ["finance.budget", "maybe"], ["nope.feature", "1"], ["storage.max_bytes", "5 parsecs"]])
      expect(() => parseEntitlementValue(k!, v!)).toThrow(AppError);
  });
});

describe("only platform administrators", () => {
  it("can use any administration method, checked against the database each time", async () => {
    expect(await code(admin.overview(other.userId))).toBe("FORBIDDEN");
    expect(await code(admin.listUsers(other.userId))).toBe("FORBIDDEN");
    expect(await code(admin.assignPlan(other.userId, other.orgId, { planId: "00000000-0000-0000-0000-000000000000", periodEnd: null, reason: "self-upgrade" }))).toBe("FORBIDDEN");
    expect(await code(planAdmin.list(other.userId))).toBe("FORBIDDEN");
    expect(await code(support.list(other.userId))).toBe("FORBIDDEN");
    // A revoked administrator loses access immediately, whatever their session says.
    const temp = await makeAdmin();
    expect(await code(admin.overview(temp.userId))).toBe("ok");
    await db.update(users).set({ isPlatformAdmin: false }).where(eq(users.id, temp.userId));
    expect(await code(admin.overview(temp.userId))).toBe("FORBIDDEN");
  });
});

describe("users", () => {
  it("lists and searches users without exposing password hashes", async () => {
    const r = await admin.listUsers(root.userId, { q: other.email });
    expect(r.rows.map((x) => x.id)).toEqual([other.userId]);
    const detail = await admin.getUser(root.userId, other.userId);
    expect(detail.user.email).toBe(other.email);
    expect("passwordHash" in detail.user).toBe(false);
    expect(detail.memberships.some((m) => m.id === other.orgId && m.isOwner)).toBe(true);
    const admins = await admin.listUsers(root.userId, { filter: "admins" });
    expect(admins.rows.every((x) => x.isPlatformAdmin)).toBe(true);
  });

  it("disabling signs the user out everywhere and blocks sign-in; enabling restores it", async () => {
    const u = await createUser("To Disable");
    const { auth } = makeAuth();
    expect(await code(admin.setUserStatus(root.userId, u.userId, "disabled"))).toBe("VALIDATION"); // reason required
    const res = await admin.setUserStatus(root.userId, u.userId, "disabled", "Abuse report #12");
    expect(res.revokedSessions).toBeGreaterThan(0);
    const live = await db.select().from(sessions).where(and(eq(sessions.userId, u.userId), isNull(sessions.revokedAt)));
    expect(live).toHaveLength(0);
    expect(await code(auth.login({ email: u.email, password: PASSWORD }))).toBe("FORBIDDEN");
    expect((await lastAudit("admin.user.disabled"))?.metadata).toMatchObject({ reason: "Abuse report #12" });
    await admin.setUserStatus(root.userId, u.userId, "active", "Resolved");
    expect((await auth.login({ email: u.email, password: PASSWORD })).status).toBe("signed_in");
    expect(await code(admin.setUserStatus(root.userId, root.userId, "disabled", "oops"))).toBe("VALIDATION");
  });

  it("grants and removes the administrator role, never one's own", async () => {
    const u = await createUser("Future Admin");
    await admin.setPlatformAdmin(root.userId, u.userId, true, "New support colleague");
    expect(await code(admin.overview(u.userId))).toBe("ok");
    expect(await code(admin.setPlatformAdmin(u.userId, u.userId, false, "leaving"))).toBe("VALIDATION");
    await admin.setPlatformAdmin(root.userId, u.userId, false, "Left the team");
    expect(await code(admin.overview(u.userId))).toBe("FORBIDDEN");
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, u.userId), eq(notifications.kind, "security.alert")));
    expect(n).toBeTruthy();
    // Unverified accounts can't be made administrators.
    const { auth } = makeAuth({ requireEmailVerification: true });
    const email = `unverified-${Date.now()}@example.test`;
    await auth.register({ email, password: PASSWORD, displayName: "Unverified" });
    const [uv] = await db.select().from(users).where(eq(users.email, email));
    expect(await code(admin.setPlatformAdmin(root.userId, uv!.id, true, "test"))).toBe("VALIDATION");
    await admin.verifyEmail(root.userId, uv!.id);
    await admin.setPlatformAdmin(root.userId, uv!.id, true, "now verified");
    await admin.setPlatformAdmin(root.userId, uv!.id, false, "cleanup");
  });

  it("resets two-factor authentication and signs the user out", async () => {
    const u = await createUser("Lost Phone");
    await db.insert(twoFactorSettings).values({ userId: u.userId, secretEncrypted: "x", enabledAt: new Date() });
    expect(await code(admin.resetTwoFactor(root.userId, u.userId, ""))).toBe("VALIDATION");
    await admin.resetTwoFactor(root.userId, u.userId, "Verified by video call");
    expect(await db.select().from(twoFactorSettings).where(eq(twoFactorSettings.userId, u.userId))).toHaveLength(0);
    expect(await db.select().from(sessions).where(and(eq(sessions.userId, u.userId), isNull(sessions.revokedAt)))).toHaveLength(0);
    expect(await code(admin.resetTwoFactor(root.userId, u.userId, "again"))).toBe("VALIDATION");
  });
});

describe("organizations and subscriptions", () => {
  it("assigns a plan without payment, changes the end date, and cancels back to the default plan", async () => {
    const u = await createUser("Comped Org Owner");
    const [pro] = await db.select().from(plans).where(eq(plans.key, "research_pro"));
    const end = new Date(Date.now() + 30 * 86_400_000);
    await admin.assignPlan(root.userId, u.orgId, { planId: pro!.id, periodEnd: end, reason: "University pilot" });
    expect((await getEntitlements(db, u.orgId)).planKey).toBe("research_pro");
    const live = await db.select().from(subscriptions).where(and(eq(subscriptions.organizationId, u.orgId), inArray(subscriptions.status, ["active", "trialing", "past_due"])));
    expect(live).toHaveLength(1);
    expect(live[0]!.provider).toBe("manual");

    expect(await code(admin.setPeriodEnd(root.userId, u.orgId, new Date(Date.now() - 1000), "past"))).toBe("VALIDATION");
    const later = new Date(Date.now() + 90 * 86_400_000);
    await admin.setPeriodEnd(root.userId, u.orgId, later, "Pilot extended");
    expect((await admin.getOrganization(root.userId, u.orgId)).live?.s.currentPeriodEnd?.toISOString()).toBe(later.toISOString());

    await admin.cancelSubscription(root.userId, u.orgId, { immediately: false, reason: "Pilot ending" });
    expect((await admin.getOrganization(root.userId, u.orgId)).live?.s.cancelAtPeriodEnd).toBe(true);
    await admin.cancelSubscription(root.userId, u.orgId, { immediately: true, reason: "Ended early" });
    const ent = await getEntitlements(db, u.orgId);
    const [def] = await db.select().from(plans).where(eq(plans.isDefault, true));
    expect(ent.planId).toBe(def!.id);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, u.userId), eq(notifications.kind, "billing.subscription")));
    expect(n).toBeTruthy();
    const org = await admin.getOrganization(root.userId, u.orgId);
    expect(org.audit.map((a) => a.a.action)).toEqual(expect.arrayContaining(["admin.subscription.assigned", "admin.subscription.period_changed", "admin.subscription.canceled"]));
  });

  it("overrides entitlements per organization, with expiry, and removes them", async () => {
    const u = await createUser("Override Org");
    expect((await getEntitlements(db, u.orgId)).values["integrations.google_drive"]).toBe(false);
    await admin.setOverride(root.userId, u.orgId, { featureKey: "integrations.google_drive", value: "on", reason: "Grant for thesis", expiresAt: null });
    await admin.setOverride(root.userId, u.orgId, { featureKey: "storage.max_bytes", value: "20 GB", reason: "Large datasets", expiresAt: new Date(Date.now() + 86_400_000) });
    let ent = await getEntitlements(db, u.orgId);
    expect(ent.values["integrations.google_drive"]).toBe(true);
    expect(ent.values["storage.max_bytes"]).toBe(20 * 1024 ** 3);
    expect(await code(admin.setOverride(root.userId, u.orgId, { featureKey: "ai.agents", value: "ultra", reason: "x y z", expiresAt: null }))).toBe("VALIDATION");
    await admin.removeOverride(root.userId, u.orgId, "integrations.google_drive");
    ent = await getEntitlements(db, u.orgId);
    expect(ent.values["integrations.google_drive"]).toBe(false);
  });

  it("adjusts prepaid credit and lists subscriptions", async () => {
    const u = await createUser("Credit Org");
    await admin.adjustCredit(root.userId, u.orgId, { usd: 25, reason: "Goodwill after outage" });
    await admin.adjustCredit(root.userId, u.orgId, { usd: -5, reason: "Correction" });
    expect((await admin.getOrganization(root.userId, u.orgId)).creditMicros).toBe(20_000_000);
    expect(await code(admin.adjustCredit(root.userId, u.orgId, { usd: 0, reason: "nothing" }))).toBe("VALIDATION");
    const subs = await admin.listSubscriptions(root.userId, { filter: "live" });
    expect(subs.total).toBeGreaterThan(0);
    const orgs = await admin.listOrganizations(root.userId, { q: u.email });
    expect(orgs.rows.map((o) => o.id)).toContain(u.orgId);
  });

  it("restores an organization scheduled for deletion", async () => {
    const u = await createUser("Deleted Org Owner");
    const org = await admin.getOrganization(root.userId, u.orgId);
    await scheduleOrganizationDeletion(db, u.userId, u.orgId, org.org.name);
    expect((await admin.listOrganizations(root.userId, { deleted: true })).rows.map((o) => o.id)).toContain(u.orgId);
    await admin.restoreOrganization(root.userId, u.orgId);
    expect((await admin.getOrganization(root.userId, u.orgId)).org.deletedAt).toBeNull();
    expect(await code(admin.restoreOrganization(root.userId, u.orgId))).toBe("VALIDATION");
  });
});

describe("plans and prices", () => {
  it("creates a plan from another, edits what it includes, and sells it", async () => {
    const [pro] = await db.select().from(plans).where(eq(plans.key, "research_pro"));
    const key = `inst_${Date.now().toString(36)}`;
    const p = await planAdmin.create(root.userId, { key, name: "Institution", description: "For departments", price: "199", currency: "usd", billingInterval: "year", isPublic: false, isActive: true, sortOrder: 50, copyFromPlanId: pro!.id });
    expect(p.priceMinor).toBe(19_900);
    expect(await code(planAdmin.create(root.userId, { key, name: "Dup", description: "", price: "0", currency: "USD", billingInterval: "month", isPublic: false, isActive: true, sortOrder: 1 }))).toBe("CONFLICT");
    const changed = await planAdmin.setEntitlements(root.userId, p.id, { "members.max": "unlimited", "storage.max_bytes": "1 TB", "finance.budget": "on" });
    expect(changed).toBeGreaterThan(0);
    const u = await createUser("Institution Org");
    await admin.assignPlan(root.userId, u.orgId, { planId: p.id, periodEnd: null, reason: "Signed contract" });
    const ent = await getEntitlements(db, u.orgId);
    expect(ent.values["members.max"]).toBeNull();
    expect(ent.values["storage.max_bytes"]).toBe(1024 ** 4);

    const pp = await planAdmin.createPricePoint(root.userId, { kind: "plan", planId: p.id, interval: "year", currency: "KES", amount: "25,000", label: "Institution (yearly, KES)" });
    expect(pp.amountMinor).toBe(2_500_000);
    const pay = new PaymentService(db, { providers: [], appUrl: "https://research.test" } as never);
    expect((await pay.catalogue()).map((c) => c.p.id)).toContain(pp.id);

    // Retiring the plan hides it from sale and switches its prices off.
    await planAdmin.update(root.userId, p.id, { name: "Institution", description: "For departments", price: "199", currency: "USD", billingInterval: "year", isPublic: false, isActive: false, sortOrder: 50 });
    expect((await pay.catalogue()).map((c) => c.p.id)).not.toContain(pp.id);
    const [after] = await db.select().from(pricePoints).where(eq(pricePoints.id, pp.id));
    expect(after!.active).toBe(0);
    expect(await code(planAdmin.setPricePointActive(root.userId, pp.id, true))).toBe("VALIDATION");
    expect((await lastAudit("admin.plan.entitlements_changed"))?.metadata).toBeTruthy();
  });

  it("keeps the default plan free and active", async () => {
    const [def] = await db.select().from(plans).where(eq(plans.isDefault, true));
    expect(await code(planAdmin.update(root.userId, def!.id, { name: def!.name, description: def!.description, price: "5", currency: def!.currency, billingInterval: "month", isPublic: true, isActive: true, sortOrder: def!.sortOrder }))).toBe("VALIDATION");
    const [pro] = await db.select().from(plans).where(eq(plans.key, "research_pro"));
    expect(await code(planAdmin.setDefault(root.userId, pro!.id))).toBe("VALIDATION");
    expect(await code(planAdmin.createPricePoint(root.userId, { kind: "plan", planId: def!.id, interval: "month", currency: "USD", amount: "1", label: "Free?" }))).toBe("VALIDATION");
    const credits = await planAdmin.createPricePoint(root.userId, { kind: "credits", currency: "USD", amount: "15", creditUsd: "15", label: "US$15 AI credit" });
    expect(credits.creditMicros).toBe(15_000_000);
    await planAdmin.setPricePointActive(root.userId, credits.id, false);
  });
});

describe("enquiries", () => {
  it("takes a guest enquiry, emails a private link, and keeps notes internal", async () => {
    const email = `guest-${Date.now()}@example.test`;
    const { ticket, link } = await support.create({ name: "Jane Guest", email, category: "sales", subject: "Pricing for 40 students", body: "Do you offer a department plan for 40 MSc students?" });
    expect(ticket.reference).toMatch(/^RM-[A-Z2-9]{6}$/);
    expect(mailer.last(email)?.text).toContain(link);
    const token = new URL(link).searchParams.get("t")!;
    // Admins are told about it.
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, root.userId), eq(notifications.kind, "support.enquiry")));
    expect(n?.link).toBe(`/app/admin/enquiries/${ticket.id}`);

    expect(await code(support.forGuest(ticket.id, "wrong-token-wrong-token-wrong-tok"))).toBe("NOT_FOUND");
    expect(await code(support.forGuest(ticket.id, ""))).toBe("NOT_FOUND");

    await support.addNote(root.userId, ticket.id, "Probably the Institution plan; check with finance.");
    await support.reply(root.userId, ticket.id, "Yes, we do. I've attached our department pricing.");
    expect(mailer.last(email)?.subject).toContain(ticket.reference);
    expect(mailer.last(email)?.text).toContain("department pricing");
    expect(mailer.last(email)?.text).not.toContain("check with finance");

    const view = await support.forGuest(ticket.id, token);
    expect(view.ticket.status).toBe("pending");
    expect(view.messages.map((m) => m.authorType)).toEqual(["requester", "staff"]);

    await support.requesterReply({ token }, ticket.id, "Great, can we start next month?");
    expect((await support.get(root.userId, ticket.id)).ticket.status).toBe("open");
    await support.update(root.userId, ticket.id, { status: "closed" });
    expect(await code(support.requesterReply({ token }, ticket.id, "One more thing"))).toBe("VALIDATION");
    const all = await db.select().from(supportTicketMessages).where(eq(supportTicketMessages.ticketId, ticket.id));
    expect(all.map((m) => m.authorType).sort()).toEqual(["note", "requester", "requester", "staff"]);
  });

  it("uses the signed-in account's own address and keeps enquiries private to their requester", async () => {
    const { ticket } = await support.create({ name: "Spoofed Name", email: "ceo@example.test", category: "technical", subject: "Export fails", body: "The Word export of chapter 2 fails every time.", userId: other.userId, organizationId: other.orgId });
    expect(ticket.requesterEmail).toBe(other.email);
    expect(ticket.organizationId).toBe(other.orgId);
    expect(ticket.source).toBe("in_app");
    const intruder = await createUser("Intruder");
    expect(await code(support.forUser(intruder.userId, ticket.id))).toBe("NOT_FOUND");
    expect(await code(support.requesterReply({ userId: intruder.userId }, ticket.id, "hijack"))).toBe("NOT_FOUND");
    expect((await support.listForUser(other.userId)).map((t) => t.id)).toContain(ticket.id);
    expect(await support.listForUser(intruder.userId)).toHaveLength(0);

    await support.reply(root.userId, ticket.id, "Fixed in today's update — please try again.", { status: "resolved" });
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, other.userId), eq(notifications.kind, "support.reply")));
    expect(n?.link).toBe(`/app/help/${ticket.id}`);
    const view = await support.forUser(other.userId, ticket.id);
    expect(view.ticket.status).toBe("resolved");
    await support.requesterReply({ userId: other.userId }, ticket.id, "Still failing for me.");
    expect((await support.get(root.userId, ticket.id)).ticket.status).toBe("open");

    const listed = await support.list(root.userId, { q: ticket.reference });
    expect(listed.rows.map((r) => r.t.id)).toEqual([ticket.id]);
    expect(await code(support.update(root.userId, ticket.id, { assignedToUserId: other.userId }))).toBe("VALIDATION");
    await support.update(root.userId, ticket.id, { assignedToUserId: root.userId, priority: "high" });
    expect((await support.counts(root.userId)).mine).toBeGreaterThan(0);
  });

  it("validates input", async () => {
    expect(await code(support.create({ name: "A", email: "x@example.test", category: "general", subject: "Hi", body: "Hello there, a question." }))).toBe("VALIDATION");
    expect(await code(support.create({ name: "Al", email: "not-an-email", category: "general", subject: "Hello", body: "Hello there, a question." }))).toBe("VALIDATION");
    expect(await code(support.create({ name: "Al", email: "x@example.test", category: "general", subject: "Hello", body: "short" }))).toBe("VALIDATION");
    const { ticket } = await support.create({ name: "Al", email: "x@example.test", category: "made-up", subject: "Line\r\nBcc: victim@example.test", body: "Hello there, a question." });
    expect(ticket.category).toBe("general");
    expect(ticket.subject).not.toMatch(/[\r\n]/);
  });
});

describe("audit and integrations", () => {
  it("records administrator actions and lists them", async () => {
    const r = await admin.listAudit(root.userId, { adminOnly: true });
    expect(r.rows.length).toBeGreaterThan(5);
    expect(r.rows.every((x) => x.a.action.startsWith("admin."))).toBe(true);
    const actors = await admin.listApifyActors(root.userId);
    if (actors[0]) {
      await admin.setApifyActorEnabled(root.userId, actors[0].id, true);
      await admin.setApifyActorEnabled(root.userId, actors[0].id, false);
    }
    const o = await admin.overview(root.userId);
    expect(o.users.admins).toBeGreaterThan(0);
    expect(o.enquiries.open).toBeGreaterThan(0);
  });
});
