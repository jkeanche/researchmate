import { createHash } from "node:crypto";
import { connectedAccounts, externalFileReferences, files as filesTable, organizationEntitlementOverrides } from "@researchmate/database";
import { getUsage } from "@researchmate/entitlements";
import { DriveService } from "@researchmate/integrations";
import { ProjectService } from "@researchmate/research";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, fileServices, pdfBuffer, setPlan, streamOf, testDb } from "./helpers";
import { startFakeGoogle } from "./support/fake-google";

let g: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => (g = await startFakeGoogle()));
afterAll(async () => {
  await g.close();
  await closeTestDb();
});

const drive = () => new DriveService(testDb(), fileServices().files, { clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:3000/api/integrations/google/callback", scope: "drive.file", maxImportBytes: 10 * 1024 * 1024, endpoints: g.endpoints });

async function connected() {
  const u = await createUser();
  await setPlan(u.orgId, "research_pro");
  const start = await drive().startAuth(u.userId, u.orgId);
  await drive().completeAuth(u.userId, u.orgId, "good-code", start.verifier);
  return u;
}

describe("Google Drive", () => {
  it("is gated by the plan and uses PKCE with the minimal scope", async () => {
    const free = await createUser();
    await expect(drive().startAuth(free.userId, free.orgId)).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    const u = await createUser();
    await setPlan(u.orgId, "research_pro");
    const s = await drive().startAuth(u.userId, u.orgId);
    const url = new URL(s.url);
    expect(url.searchParams.get("scope")).toContain("auth/drive.file");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe(s.state);
    await expect(drive().completeAuth(u.userId, u.orgId, "bad-code", s.verifier)).rejects.toThrow(/rejected|expired/);
  });

  it("stores tokens encrypted and never exposes them", async () => {
    const u = await connected();
    const [row] = await testDb().select().from(connectedAccounts).where(eq(connectedAccounts.userId, u.userId));
    expect(row!.encryptedRefreshToken).not.toContain("rt-secret");
    const pub = await drive().connection(u.userId, u.orgId);
    expect(pub).toMatchObject({ accountEmail: "researcher@gmail.test", status: "active" });
    expect(JSON.stringify(pub)).not.toMatch(/rt-secret|at-\d/);
  });

  it("imports files (Google Docs exported to DOCX), detects duplicates, and versions changed files", async () => {
    const u = await connected();
    const project = await new ProjectService(testDb()).create(u.userId, u.orgId, { title: "Drive project", researchType: "custom", workflowTemplateKey: "" });
    g.files.set("pdfFile0000001", { id: "pdfFile0000001", name: "paper.pdf", mimeType: "application/pdf", content: pdfBuffer(4000), md5: "aaa", modifiedTime: "2026-10-01T10:00:00.000Z" });
    const docx = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(2000, 1)]);
    g.files.set("gdoc000000001", { id: "gdoc000000001", name: "Chapter 1", mimeType: "application/vnd.google-apps.document", content: docx, modifiedTime: "2026-10-02T10:00:00.000Z" });

    const list = await drive().listFiles(u.userId, u.orgId);
    expect(list.files.map((f) => f.name).sort()).toEqual(["Chapter 1", "paper.pdf"]);

    const job = await drive().requestImport(u.userId, u.orgId, "pdfFile0000001", project.id);
    await drive().processJob(job.id);
    const [done] = await drive().listJobs(u.userId, u.orgId);
    expect(done).toMatchObject({ status: "succeeded" });
    const fileId = String(done!.result!.fileId);
    const [f] = await testDb().select().from(filesTable).where(eq(filesTable.id, fileId));
    expect(f).toMatchObject({ originalName: "paper.pdf", projectId: project.id, mimeType: "application/pdf" });
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(4000);

    // Same file again → no new copy, no extra storage.
    const again = await drive().requestImport(u.userId, u.orgId, "pdfFile0000001", project.id);
    await drive().processJob(again.id);
    expect((await drive().listJobs(u.userId, u.orgId))[0]!.result).toMatchObject({ fileId, duplicate: true });
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(4000);

    // Changed in Drive → stored as a new version of the same file.
    g.files.set("pdfFile0000001", { ...g.files.get("pdfFile0000001")!, content: pdfBuffer(5000), md5: "bbb", modifiedTime: "2026-10-05T10:00:00.000Z" });
    const changed = await drive().requestImport(u.userId, u.orgId, "pdfFile0000001", project.id);
    await drive().processJob(changed.id);
    expect((await drive().listJobs(u.userId, u.orgId))[0]!.result).toMatchObject({ fileId, newVersion: true });
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(9000);

    const gd = await drive().requestImport(u.userId, u.orgId, "gdoc000000001", project.id);
    await drive().processJob(gd.id);
    const r = (await drive().listJobs(u.userId, u.orgId))[0]!;
    expect(r.status).toBe("succeeded");
    const [docFile] = await testDb().select().from(filesTable).where(eq(filesTable.id, String(r.result!.fileId)));
    expect(docFile!.originalName).toBe("Chapter 1.docx");
  });

  it("references cost no storage; imports respect quotas; unknown files fail clearly", async () => {
    const u = await connected();
    await testDb().insert(organizationEntitlementOverrides).values({ organizationId: u.orgId, featureKey: "storage.max_bytes", value: 3000, reason: "test" });
    g.files.set("bigFile000000001", { id: "bigFile000000001", name: "big.pdf", mimeType: "application/pdf", content: pdfBuffer(4000), md5: "c", modifiedTime: "2026-10-01T10:00:00.000Z" });
    const j = await drive().requestImport(u.userId, u.orgId, "bigFile000000001", null);
    await drive().processJob(j.id);
    expect((await drive().listJobs(u.userId, u.orgId))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/storage allowance/) });
    const missing = await drive().requestImport(u.userId, u.orgId, "doesNotExist0001", null);
    await drive().processJob(missing.id);
    expect((await drive().listJobs(u.userId, u.orgId))[0]!.error).toMatch(/isn't available to ResearchMate/);
    expect((await getUsage(testDb(), u.orgId)).storageBytes).toBe(0);
    expect(await testDb().select().from(externalFileReferences).where(and(eq(externalFileReferences.organizationId, u.orgId), isNull(externalFileReferences.importedFileId)))).toHaveLength(0);
  });

  it("exports a file to Drive, refreshing an expired token", async () => {
    const u = await connected();
    const { files } = fileServices();
    const buf = pdfBuffer(3000);
    const f = await files.upload({ actorUserId: u.userId, organizationId: u.orgId, filename: "report.pdf", declaredSize: buf.length, body: streamOf(buf) });
    await testDb().update(connectedAccounts).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(connectedAccounts.userId, u.userId));
    const before = g.state.refreshCount;
    const job = await drive().requestExport(u.userId, u.orgId, f.id, "folder0000000001");
    await drive().processJob(job.id);
    expect((await drive().listJobs(u.userId, u.orgId))[0]).toMatchObject({ status: "succeeded" });
    expect(g.state.refreshCount).toBe(before + 1);
    expect(g.state.uploads.at(-1)).toEqual({ metadata: { name: "report.pdf", parents: ["folder0000000001"] }, bytes: 3000 });
    const other = await createUser();
    await expect(drive().requestExport(other.userId, u.orgId, f.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks the account for reconnection when Google revokes the grant, and revokes on disconnect", async () => {
    const u = await connected();
    await testDb().update(connectedAccounts).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(connectedAccounts.userId, u.userId));
    g.state.refreshRevoked = true;
    await expect(drive().listFiles(u.userId, u.orgId)).rejects.toThrow(/Reconnect/);
    expect((await drive().connection(u.userId, u.orgId))!.status).toBe("reauth_required");
    g.state.refreshRevoked = false;
    await drive().disconnect(u.userId, u.orgId);
    expect(g.state.revoked.at(-1)).toBe("rt-secret");
    expect(await drive().connection(u.userId, u.orgId)).toBeNull();
    const [row] = await testDb().select().from(connectedAccounts).where(eq(connectedAccounts.userId, u.userId));
    expect(row!.encryptedRefreshToken).toBe("revoked");
  });
});
