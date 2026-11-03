import { sessionIdFromToken } from "@researchmate/auth";
import { LedgerService } from "@researchmate/billing";
import { creditLedgerEntries, fileVersions, invoices, organizations, payments, researchProjects, retainedFinancialRecords, sessions, users, userProfiles } from "@researchmate/database";
import { FinanceService } from "@researchmate/finance";
import { PlanningService } from "@researchmate/planning";
import { ProjectService } from "@researchmate/research";
import { purgeDeletedOrganizations } from "@researchmate/storage";
import { addMemberByEmail, getOrgAccess, listScheduledDeletions, restoreOrganization, scheduleOrganizationDeletion } from "@researchmate/tenancy";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, fileServices, makeAuth, PASSWORD, setPlan, streamOf, testDb } from "./helpers";

afterAll(closeTestDb);
const db = () => testDb();
const appendOnly = (e: unknown) => /append-only|immutable|cannot be deleted/.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message));

async function populated() {
  const owner = await createUser("Owner");
  await setPlan(owner.orgId, "research_pro");
  const project = await new ProjectService(db()).create(owner.userId, owner.orgId, { title: "Purge me", researchType: "masters_thesis", workflowTemplateKey: "" });
  const fin = new FinanceService(db());
  await fin.configure(owner.userId, project.id, { enabled: true, baseCurrency: "KES" });
  const v = await fin.draft(owner.userId, project.id);
  await fin.setAllocation(owner.userId, v.id, { categoryKey: "travel", amount: "500" });
  await fin.approveBudget(owner.userId, v.id);
  const src = await fin.createFundingSource(owner.userId, project.id, { name: "Grant", kind: "grant", awarded: "1000" });
  await fin.recordReceipt(owner.userId, src.id, { receivedDate: "2026-10-01", amount: "1000" });
  const planning = new PlanningService(db());
  await planning.createTask(owner.userId, project.id, { title: "Fieldwork", startDate: "2026-11-01", endDate: "2026-11-30" });
  await planning.createBaseline(owner.userId, project.id, { name: "Original plan" });
  const { files, driver } = fileServices();
  const body = Buffer.from("interview transcript");
  const f = await files.upload({ actorUserId: owner.userId, organizationId: owner.orgId, projectId: project.id, filename: "t1.txt", declaredSize: body.length, body: streamOf(body) });
  const [fv] = await db().select().from(fileVersions).where(eq(fileVersions.fileId, f.id));
  await new LedgerService(db()).addCredit(db(), { organizationId: owner.orgId, amountMicros: 5_000_000, kind: "adjustment", description: "Test credit", idempotencyKey: `t:${owner.orgId}` });
  const [pay] = await db().insert(payments).values({ organizationId: owner.orgId, provider: "paystack", reference: `ref-${owner.orgId}`, kind: "credits", currency: "KES", amountMinor: 100_00, status: "succeeded" }).returning();
  await db().insert(invoices).values({ paymentId: pay!.id, number: `RM-T-${owner.orgId.slice(0, 8)}`, organizationId: owner.orgId, currency: "KES", amountMinor: 100_00, lines: [{ description: "Credit", amountMinor: 100_00 }], billTo: { organization: "Owner's workspace", email: owner.email } });
  return { owner, project, driver, storageKey: fv!.storageKey };
}

describe("organization deletion and purge", () => {
  it("schedule → members lose access → restore → schedule → purge keeps only financial records", async () => {
    const { owner, project, driver, storageKey } = await populated();
    const [org] = await db().select().from(organizations).where(eq(organizations.id, owner.orgId));
    const member = await createUser("Member");
    await addMemberByEmail(db(), owner.userId, owner.orgId, member.email, "org_member");

    await expect(scheduleOrganizationDeletion(db(), member.userId, owner.orgId, org!.name)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scheduleOrganizationDeletion(db(), owner.userId, owner.orgId, "wrong name")).rejects.toThrow(/exactly/);
    await scheduleOrganizationDeletion(db(), owner.userId, owner.orgId, org!.name);
    await expect(getOrgAccess(db(), member.userId, owner.orgId)).rejects.toThrow();
    await expect(getOrgAccess(db(), owner.userId, owner.orgId)).rejects.toThrow();
    expect((await listScheduledDeletions(db(), owner.userId)).map((o) => o.id)).toEqual([owner.orgId]);
    await expect(restoreOrganization(db(), member.userId, owner.orgId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await restoreOrganization(db(), owner.userId, owner.orgId);
    expect((await getOrgAccess(db(), member.userId, owner.orgId)).organizationId).toBe(owner.orgId);

    // Not yet due: nothing happens. Append-only rows stay protected meanwhile.
    await scheduleOrganizationDeletion(db(), owner.userId, owner.orgId, org!.name);
    await purgeDeletedOrganizations(db(), driver, new Date());
    expect(await db().select().from(organizations).where(eq(organizations.id, owner.orgId))).toHaveLength(1);
    await expect(db().delete(creditLedgerEntries).where(eq(creditLedgerEntries.organizationId, owner.orgId))).rejects.toSatisfy(appendOnly);
    expect(await db().select().from(researchProjects).where(eq(researchProjects.id, project.id))).toHaveLength(1);

    const r = await purgeDeletedOrganizations(db(), driver, new Date(Date.now() + 31 * 86_400_000));
    expect(r.organizations).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(organizations).where(eq(organizations.id, owner.orgId))).toHaveLength(0);
    expect(await db().select().from(researchProjects).where(eq(researchProjects.organizationId, owner.orgId))).toHaveLength(0);
    await expect(driver.get(storageKey)).rejects.toThrow();
    const [kept] = await db().select().from(retainedFinancialRecords).where(eq(retainedFinancialRecords.organizationId, owner.orgId));
    expect(kept!.organizationName).toBe(org!.name);
    expect(kept!.invoices).toHaveLength(1);
    expect(kept!.payments).toHaveLength(1);
    expect(kept!.ledger).toHaveLength(1);
    await expect(db().update(retainedFinancialRecords).set({ organizationName: "x" }).where(eq(retainedFinancialRecords.id, kept!.id))).rejects.toSatisfy(appendOnly);
    // The people remain; only the workspace is gone.
    expect(await db().select().from(users).where(eq(users.id, member.userId))).toHaveLength(1);
  });

  it("purging one organization leaves others untouched", async () => {
    const a = await populated();
    const b = await populated();
    const [orgA] = await db().select().from(organizations).where(eq(organizations.id, a.owner.orgId));
    await scheduleOrganizationDeletion(db(), a.owner.userId, a.owner.orgId, orgA!.name, 0);
    await purgeDeletedOrganizations(db(), a.driver, new Date(Date.now() + 1000));
    expect(await db().select().from(organizations).where(eq(organizations.id, a.owner.orgId))).toHaveLength(0);
    expect(await db().select().from(researchProjects).where(eq(researchProjects.id, b.project.id))).toHaveLength(1);
    expect((await b.driver.get(b.storageKey))).toBeTruthy();
    await expect(db().delete(creditLedgerEntries).where(eq(creditLedgerEntries.organizationId, b.owner.orgId))).rejects.toSatisfy(appendOnly);
  });
});

describe("account deletion", () => {
  it("requires reauthentication, refuses while others depend on an owned workspace, then pseudonymises", async () => {
    const { auth } = makeAuth();
    const u = await createUser("Leaving researcher");
    await setPlan(u.orgId, "research_team");
    const sid = sessionIdFromToken(u.token);
    await expect(auth.deleteAccount({ userId: u.userId, sessionId: sid, password: "wrong password" })).rejects.toThrow(/incorrect/);

    const colleague = await createUser("Colleague");
    await setPlan(colleague.orgId, "research_team");
    await addMemberByEmail(db(), u.userId, u.orgId, colleague.email, "org_member");
    await expect(auth.deleteAccount({ userId: u.userId, sessionId: sid, password: PASSWORD })).rejects.toThrow(/other members/);
    // The user is also a member of the colleague's workspace; that membership simply ends.
    await addMemberByEmail(db(), colleague.userId, colleague.orgId, u.email, "org_member");
    const { removeMember } = await import("@researchmate/tenancy");
    await removeMember(db(), u.userId, u.orgId, colleague.userId);

    const r = await auth.deleteAccount({ userId: u.userId, sessionId: sid, password: PASSWORD });
    expect(r.scheduledOrganizations).toHaveLength(1);
    const [row] = await db().select().from(users).where(eq(users.id, u.userId));
    expect(row).toMatchObject({ email: `deleted-${u.userId}@deleted.invalid`, status: "disabled", emailVerifiedAt: null });
    expect((await db().select().from(userProfiles).where(eq(userProfiles.userId, u.userId)))[0]!.displayName).toBe("Deleted user");
    expect(await db().select().from(sessions).where(eq(sessions.userId, u.userId))).toHaveLength(0);
    await expect(getOrgAccess(db(), u.userId, colleague.orgId)).rejects.toThrow();
    expect((await db().select().from(organizations).where(eq(organizations.id, u.orgId)))[0]!.deletedAt).not.toBeNull();
    const login = await auth.login({ email: u.email, password: PASSWORD }).catch((e: Error) => e);
    expect(login).toBeInstanceOf(Error);
  });
});
