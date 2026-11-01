import { afterAll, describe, expect, it } from "vitest";
import { canUseFeature, checkIntegrationAccess, getEntitlements, getLimitStatus, getUsage } from "@researchmate/entitlements";
import { fileProcessingJobs, files, fileStorageReservations, organizationEntitlementOverrides } from "@researchmate/database";
import { expireReservations, purgeDeletedFiles } from "@researchmate/storage";
import { createOrganization } from "@researchmate/tenancy";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, createUser, fileServices, pdfBuffer, setPlan, streamOf, testDb, textBuffer } from "./helpers";

afterAll(closeTestDb);

const MB = 1024 * 1024;

describe("entitlements", () => {
  it("Free plan: no AI, no integrations, overview-only planning", async () => {
    const u = await createUser();
    const ent = await getEntitlements(testDb(), u.orgId);
    expect(ent.planKey).toBe("free");
    expect(ent.values["projects.max"]).toBe(1);
    expect(ent.values["files.max"]).toBe(1);
    expect(ent.values["storage.max_bytes"]).toBe(5 * MB);
    for (const f of ["ai.agents", "ai.embeddings", "ai.document_processing", "research.web", "integrations.mcp", "integrations.apify", "integrations.google_drive", "documents.generation", "api.access", "collaboration.supervisor", "finance.budget"] as const) {
      expect(await canUseFeature(testDb(), u.orgId, f), f).toBe(false);
    }
    expect(ent.values["planning.gantt"]).toBe("overview");
    await expect(checkIntegrationAccess(testDb(), u.orgId, "google_drive")).rejects.toThrow(/not included/);
  });

  it("admin overrides enable a feature for one organization only, and expire", async () => {
    const a = await createUser();
    const b = await createUser();
    const db = testDb();
    await db.insert(organizationEntitlementOverrides).values({ organizationId: a.orgId, featureKey: "integrations.google_drive", value: true, reason: "pilot" });
    await expect(checkIntegrationAccess(db, a.orgId, "google_drive")).resolves.toBeUndefined();
    await expect(checkIntegrationAccess(db, b.orgId, "google_drive")).rejects.toThrow();
    await db.update(organizationEntitlementOverrides).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(organizationEntitlementOverrides.organizationId, a.orgId));
    await expect(checkIntegrationAccess(db, a.orgId, "google_drive")).rejects.toThrow();
  });

  it("paid plans resolve from the live subscription", async () => {
    const u = await createUser();
    await setPlan(u.orgId, "research_pro");
    const ent = await getEntitlements(testDb(), u.orgId);
    expect(ent.planKey).toBe("research_pro");
    expect(ent.values["projects.max"]).toBe(15);
    expect(await canUseFeature(testDb(), u.orgId, "integrations.mcp")).toBe(true);
  });

  it("users cannot multiply Free limits by creating extra organizations", async () => {
    const u = await createUser();
    await expect(testDb().transaction((tx) => createOrganization(tx, { ownerUserId: u.userId, name: "Second Lab", kind: "team" }))).rejects.toThrow(/already own an organization on the Free plan/);
    await setPlan(u.orgId, "starter");
    const org = await testDb().transaction((tx) => createOrganization(tx, { ownerUserId: u.userId, name: "Second Lab", kind: "team" }));
    expect(org.kind).toBe("team");
  });
});

describe("projects quota", () => {
  it("Free plan allows exactly one project, counting archived projects", async () => {
    const u = await createUser();
    const { projects } = fileServices();
    const p = await projects.create(u.userId, u.orgId, { title: "Soil moisture study", researchType: "masters_thesis" });
    await expect(projects.create(u.userId, u.orgId, { title: "Second project", researchType: "custom" })).rejects.toThrow(/allows 1 project/);
    await projects.archive(u.userId, p.id);
    await expect(projects.create(u.userId, u.orgId, { title: "Third project", researchType: "custom" })).rejects.toThrow(/allows 1 project/);
  });

  it("concurrent project creation cannot exceed the quota", async () => {
    const u = await createUser();
    const { projects } = fileServices();
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => projects.create(u.userId, u.orgId, { title: `Parallel ${i}`, researchType: "custom" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getUsage(testDb(), u.orgId)).projects).toBe(1);
  });

  it("validates project input", async () => {
    const u = await createUser();
    const { projects } = fileServices();
    await expect(projects.create(u.userId, u.orgId, { title: "x", researchType: "custom" })).rejects.toThrow(/at least 3/);
    await expect(
      projects.create(u.userId, u.orgId, { title: "Bad dates", researchType: "custom", startDate: "2026-12-01", expectedCompletionDate: "2026-01-01" }),
    ).rejects.toThrow(/on or after/);
  });
});

describe("file storage and quotas", () => {
  it("Free plan: stores one file ≤ 5 MB without AI processing", async () => {
    const u = await createUser();
    const { files: svc, driver } = fileServices();
    const buf = pdfBuffer(1 * MB);
    const file = await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "paper.pdf", declaredSize: buf.length, body: streamOf(buf) });
    expect(file.processingStatus).toBe("stored");
    expect(file.aiProcessingAllowed).toBe(false);
    expect(file.mimeType).toBe("application/pdf");

    const jobs = await testDb().select().from(fileProcessingJobs).where(eq(fileProcessingJobs.fileId, file.id));
    expect(jobs).toHaveLength(0); // no hidden background processing

    const second = textBuffer(100);
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "notes.txt", declaredSize: 100, body: streamOf(second) })).rejects.toThrow(/allows 1 file/);

    const dl = await svc.openForDownload(u.userId, file.id);
    const chunks: Buffer[] = [];
    for await (const c of dl.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(buf)).toBe(true);
    expect(await driver.exists(dl.version.storageKey)).toBe(true);
  });

  it("Free plan: rejects files over 5 MB before storing anything", async () => {
    const u = await createUser();
    const { files: svc } = fileServices();
    const buf = pdfBuffer(5 * MB + 1);
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "big.pdf", declaredSize: buf.length, body: streamOf(buf) })).rejects.toThrow(/at most 5 MB/);
    const usage = await getUsage(testDb(), u.orgId);
    expect(usage.files).toBe(0);
    expect(usage.reservedBytes).toBe(0);
  });

  it("enforces the total storage quota", async () => {
    const u = await createUser();
    await setPlan(u.orgId, "starter");
    const db = testDb();
    // Shrink storage for this org via override to keep the test fast.
    await db.insert(organizationEntitlementOverrides).values({ organizationId: u.orgId, featureKey: "storage.max_bytes", value: 3 * MB, reason: "test" });
    const { files: svc } = fileServices();
    const two = pdfBuffer(2 * MB);
    await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "a.pdf", declaredSize: two.length, body: streamOf(two) });
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "b.pdf", declaredSize: two.length, body: streamOf(two) })).rejects.toThrow(/storage allowance/);
  });

  it("concurrent uploads cannot exceed the file quota", async () => {
    const u = await createUser();
    const { files: svc } = fileServices();
    const buf = pdfBuffer(64 * 1024);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: `p${i}.pdf`, declaredSize: buf.length, body: streamOf(buf) })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const usage = await getUsage(testDb(), u.orgId);
    expect(usage.files).toBe(1);
    expect(usage.reservedFiles).toBe(0);
  });

  it("rejects content that does not match its extension and releases the reservation", async () => {
    const u = await createUser();
    const { files: svc } = fileServices();
    const fake = Buffer.from("MZ\x90\x00 this is an exe", "latin1");
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "paper.pdf", declaredSize: fake.length, body: streamOf(fake) })).rejects.toThrow(/does not/);
    const reservations = await testDb().select().from(fileStorageReservations).where(eq(fileStorageReservations.organizationId, u.orgId));
    expect(reservations.every((r) => r.status === "released")).toBe(true);
    expect((await getUsage(testDb(), u.orgId)).reservedBytes).toBe(0);
  });

  it("rejects bodies that differ from the declared size", async () => {
    const u = await createUser();
    const { files: svc } = fileServices();
    const buf = pdfBuffer(2000);
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "a.pdf", declaredSize: 1000, body: streamOf(buf) })).rejects.toThrow(/larger than its declared/);
    await expect(svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "a.pdf", declaredSize: 3000, body: streamOf(buf) })).rejects.toThrow(/incomplete/);
  });

  it("versions files, counts every version against storage, and frees quota on delete", async () => {
    const u = await createUser();
    await setPlan(u.orgId, "starter");
    const { files: svc, driver } = fileServices();
    const v1 = pdfBuffer(100_000);
    const f = await svc.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "draft.pdf", declaredSize: v1.length, body: streamOf(v1) });
    const v2 = pdfBuffer(150_000);
    const updated = await svc.uploadNewVersion({ actorUserId: u.userId, fileId: f.id, filename: "draft-v2.pdf", declaredSize: v2.length, body: streamOf(v2) });
    expect(updated.currentVersion).toBe(2);
    await expect(svc.uploadNewVersion({ actorUserId: u.userId, fileId: f.id, filename: "draft.txt", declaredSize: 10, body: streamOf(textBuffer(10)) })).rejects.toThrow(/same file type/);
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(250_000);
    expect(await svc.listVersions(u.userId, f.id)).toHaveLength(2);

    const old = await svc.openForDownload(u.userId, f.id, 1);
    old.stream.destroy();
    await svc.delete(u.userId, f.id);
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(0);
    await expect(svc.openForDownload(u.userId, f.id)).rejects.toThrow(/not found/);

    // Retention purge removes objects but keeps metadata.
    await testDb().update(files).set({ deletedAt: sql`now() - interval '10 days'` }).where(eq(files.id, f.id));
    expect(await purgeDeletedFiles(testDb(), driver, 72)).toBe(2);
    expect(await driver.exists(old.version.storageKey)).toBe(false);
  });

  it("expired reservations stop counting against quota", async () => {
    const u = await createUser();
    const db = testDb();
    await db.insert(fileStorageReservations).values({ organizationId: u.orgId, userId: u.userId, bytes: 4 * MB, expiresAt: sql`now() + interval '10 minutes'` as unknown as Date });
    expect((await getUsage(db, u.orgId)).reservedBytes).toBe(4 * MB);
    await db.update(fileStorageReservations).set({ expiresAt: sql`now() - interval '1 minute'` as unknown as Date }).where(eq(fileStorageReservations.organizationId, u.orgId));
    expect((await getUsage(db, u.orgId)).reservedBytes).toBe(0);
    expect(await expireReservations(db)).toBeGreaterThanOrEqual(1);
  });

  it("downgrade keeps data and reports limits as exceeded", async () => {
    const u = await createUser();
    await setPlan(u.orgId, "starter");
    const { projects } = fileServices();
    await projects.create(u.userId, u.orgId, { title: "Project one", researchType: "custom" });
    await projects.create(u.userId, u.orgId, { title: "Project two", researchType: "custom" });
    await setPlan(u.orgId, "free");
    const status = await getLimitStatus(testDb(), u.orgId);
    expect(status.limits.find((l) => l.key === "projects.max")).toMatchObject({ limit: 1, used: 2, over: true });
    expect(await projects.list(u.userId, u.orgId)).toHaveLength(2);
    await expect(projects.create(u.userId, u.orgId, { title: "Project three", researchType: "custom" })).rejects.toThrow();
  });
});
