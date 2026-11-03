import { sessionIdFromToken } from "@researchmate/auth";
import { notifications, securityEvents, users } from "@researchmate/database";
import { FinanceService } from "@researchmate/finance";
import { PlanningService } from "@researchmate/planning";
import { ProjectService } from "@researchmate/research";
import { addMemberByEmail, deliverNotificationEmails, getPreferences, listNotifications, markRead, notify, scanDeadlines, setPreferences, unreadCount } from "@researchmate/tenancy";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, makeAuth, PASSWORD, setPlan, testDb } from "./helpers";

afterAll(closeTestDb);

const db = () => testDb();
const mine = (userId: string) => db().select().from(notifications).where(eq(notifications.userId, userId));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("notifications", () => {
  it("respects preferences, deduplicates, and keeps security email locked on", async () => {
    const u = await createUser("Prefs");
    expect(await notify(db(), { userIds: [u.userId, null], kind: "task.overdue", title: "A", dedupeKey: "k1" })).toBe(1);
    expect(await notify(db(), { userIds: [u.userId], kind: "task.overdue", title: "A again", dedupeKey: "k1" })).toBe(0);
    expect((await mine(u.userId))[0]).toMatchObject({ inApp: true, emailStatus: "pending" });

    await setPreferences(db(), u.userId, [
      { kind: "task.overdue", inApp: false, email: false },
      { kind: "milestone.due_soon", inApp: true, email: true },
      { kind: "security.alert", inApp: false, email: false },
      { kind: "not.a.kind", inApp: true, email: true },
    ]);
    const prefs = await getPreferences(db(), u.userId);
    expect(prefs.find((p) => p.kind === "task.overdue")).toMatchObject({ inApp: false, email: false });
    expect(prefs.find((p) => p.kind === "security.alert")).toMatchObject({ inApp: false, email: true, locked: true });
    expect(prefs.some((p) => p.kind === "not.a.kind")).toBe(false);

    expect(await notify(db(), { userIds: [u.userId], kind: "task.overdue", title: "Silenced" })).toBe(0);
    await notify(db(), { userIds: [u.userId], kind: "security.alert", title: "Locked" });
    const locked = (await mine(u.userId)).find((n) => n.title === "Locked")!;
    expect(locked).toMatchObject({ inApp: false, emailStatus: "pending" }); // emailed even though hidden in-app

    // In-app list and unread counts only show in-app rows, scoped to the user.
    expect((await listNotifications(db(), u.userId)).map((n) => n.title)).toEqual(["A"]);
    expect(await unreadCount(db(), u.userId)).toBe(1);
    const other = await createUser("Other");
    await markRead(db(), other.userId); // can't touch someone else's
    expect(await unreadCount(db(), u.userId)).toBe(1);
    await markRead(db(), u.userId);
    expect(await unreadCount(db(), u.userId)).toBe(0);

    await expect(notify(db(), { userIds: [u.userId], kind: "task.overdue", title: "x", link: "https://evil.example" })).rejects.toThrow(/in-app paths/);
  });

  it("delivers pending email once, skipping unverified users", async () => {
    const v = await createUser("Verified");
    const n = await createUser("Unverified");
    await db().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, v.userId));
    await db().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, n.userId));
    await notify(db(), { userIds: [v.userId, n.userId], kind: "review.requested", title: "Review requested: “Ch 1”", body: "Please look.", link: "/app/projects/x/reviews/y" });
    const out: { to: string; subject: string; text: string }[] = [];
    // Other tests may have left pending rows; deliver until ours are handled.
    for (let i = 0; i < 20 && (await mine(v.userId)).some((r) => r.emailStatus === "pending"); i++) await deliverNotificationEmails(db(), async (m) => void out.push(m), "https://rm.test/");
    const mail = out.filter((m) => m.to === v.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("https://rm.test/app/projects/x/reviews/y");
    expect(mail[0]!.text).toContain("/app/settings/notifications");
    expect(out.some((m) => m.to === n.email)).toBe(false);
    expect((await mine(n.userId))[0]!.emailStatus).toBe("skipped");
    await deliverNotificationEmails(db(), async (m) => void out.push(m), "https://rm.test");
    expect(out.filter((m) => m.to === v.email)).toHaveLength(1);
  });

  it("security notices: password change, and a sign-in from a new device but not the first one", async () => {
    const { auth } = makeAuth();
    const email = `sec-${Date.now()}@example.test`;
    const reg = await auth.register({ email, password: PASSWORD, displayName: "Sec", ctx: { ipAddress: "203.0.113.5", userAgent: "Firefox" } });
    if (reg.status !== "signed_in") throw new Error("expected sign-in");
    const uid = reg.userId;
    await auth.login({ email, password: PASSWORD, ctx: { ipAddress: "203.0.113.5", userAgent: "Firefox" } });
    await auth.login({ email, password: PASSWORD, ctx: { ipAddress: "203.0.113.5", userAgent: "Firefox" } });
    expect((await mine(uid)).filter((n) => n.title === "New sign-in to your account")).toHaveLength(0);
    await auth.login({ email, password: PASSWORD, ctx: { ipAddress: "198.51.100.9", userAgent: "Unknown/1.0" } });
    const fresh = (await mine(uid)).filter((n) => n.title === "New sign-in to your account");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: "security.alert", emailStatus: "pending", link: "/app/settings/security" });
    expect(fresh[0]!.body).toContain("198.51.100.9");
    const [sess] = await db().select().from(securityEvents).where(and(eq(securityEvents.userId, uid), eq(securityEvents.type, "login.succeeded")));
    expect(sess).toBeTruthy();
    await auth.changePassword({ userId: uid, sessionId: sessionIdFromToken(reg.token), currentPassword: PASSWORD, newPassword: "a different long passphrase 42" });
    expect((await mine(uid)).map((n) => n.title)).toContain("Your password was changed");
  });

  it("deadline scan: due soon, overdue and milestones, once per due date", async () => {
    const owner = await createUser("Planner");
    await setPlan(owner.orgId, "research_pro");
    const project = await new ProjectService(db()).create(owner.userId, owner.orgId, { title: "Deadline study", researchType: "masters_thesis", workflowTemplateKey: "" });
    const planning = new PlanningService(db());
    const mk = (title: string, start: string, end: string, extra: Record<string, unknown> = {}) => planning.createTask(owner.userId, project.id, { title, startDate: start, endDate: end, ...extra }).then((r) => r.task);
    const soon = await mk("Draft chapter 2", day(-3), day(1));
    const late = await mk("Pilot survey", day(-10), day(-2));
    const ancient = await mk("Old task", day(-60), day(-40));
    const done = await mk("Finished", day(-10), day(-1));
    await planning.updateTask(owner.userId, done.id, { status: "done" });
    await planning.createTask(owner.userId, project.id, { title: "Proposal defense", kind: "milestone", startDate: day(5) });

    await scanDeadlines(db());
    await scanDeadlines(db()); // idempotent
    const titles = (await mine(owner.userId)).map((n) => n.title);
    expect(titles.filter((t) => t === `Due on ${soon.endDate}: Draft chapter 2`)).toHaveLength(1);
    expect(titles.filter((t) => t === "Overdue: Pilot survey")).toHaveLength(1);
    expect(titles.some((t) => t.includes(ancient.title))).toBe(false); // older than two weeks
    expect(titles.some((t) => t.includes("Finished"))).toBe(false);
    expect(titles).toContain(`Milestone on ${day(5)}: Proposal defense`);
    expect(late).toBeTruthy();
  });

  it("finance: approvers hear about submitted expenses; readers about the budget threshold", async () => {
    const owner = await createUser("Finance lead");
    await setPlan(owner.orgId, "research_pro");
    const project = await new ProjectService(db()).create(owner.userId, owner.orgId, { title: "Funded study", researchType: "masters_thesis", workflowTemplateKey: "" });
    const fin = new FinanceService(db());
    await fin.configure(owner.userId, project.id, { enabled: true, baseCurrency: "KES", alertThresholdPercent: 80 });
    const v = await fin.draft(owner.userId, project.id);
    await fin.setAllocation(owner.userId, v.id, { categoryKey: "travel", amount: "1000" });
    await fin.approveBudget(owner.userId, v.id);
    const mgr = await createUser("Finance manager");
    await addMemberByEmail(db(), owner.userId, owner.orgId, mgr.email, "org_finance_manager");

    const e = await fin.createExpense(mgr.userId, project.id, { description: "Bus fares", categoryKey: "travel", expenseDate: day(0), amount: "850", submit: true });
    const pending = (await mine(owner.userId)).filter((n) => n.kind === "finance.expense_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toMatch(/850\.00/);
    expect((await mine(mgr.userId)).some((n) => n.kind === "finance.expense_pending")).toBe(false); // not the submitter

    await fin.transitionExpense(owner.userId, e.id, "approve");
    const alert = (await mine(owner.userId)).filter((n) => n.kind === "finance.budget_threshold");
    expect(alert.map((n) => n.title)).toEqual(["Budget 80% used: “Funded study”"]);
    expect(alert[0]!.body).toContain("85%");
  });
});
