import { afterAll, describe, expect, it } from "vitest";
import { projectMembers } from "@researchmate/database";
import { addMemberByEmail, changeMemberRole, getProjectAccess, listUserOrganizations, removeMember } from "@researchmate/tenancy";
import { closeTestDb, createUser, fileServices, pdfBuffer, setPlan, streamOf, testDb } from "./helpers";

afterAll(closeTestDb);

describe("tenant isolation", () => {
  it("users cannot see or touch another tenant's projects or files", async () => {
    const alice = await createUser("Alice");
    const mallory = await createUser("Mallory");
    const { projects, files } = fileServices();

    const project = await projects.create(alice.userId, alice.orgId, { title: "Confidential trial", researchType: "phd_dissertation" });
    const buf = pdfBuffer(10_000);
    const file = await files.upload({ actorUserId: alice.userId, organizationId: alice.orgId, projectId: project.id, filename: "data.pdf", declaredSize: buf.length, body: streamOf(buf) });

    await expect(projects.get(mallory.userId, project.id)).rejects.toThrow(/not found/i);
    await expect(projects.update(mallory.userId, project.id, { title: "Hijacked" })).rejects.toThrow(/not found/i);
    await expect(projects.list(mallory.userId, alice.orgId)).rejects.toThrow(/not found/i);
    await expect(files.openForDownload(mallory.userId, file.id)).rejects.toThrow(/not found/i);
    await expect(files.delete(mallory.userId, file.id)).rejects.toThrow(/not found/i);
    await expect(files.list(mallory.userId, alice.orgId)).rejects.toThrow(/not found/i);
    // Uploading into someone else's org/project is refused.
    await expect(
      files.upload({ actorUserId: mallory.userId, organizationId: alice.orgId, filename: "x.pdf", declaredSize: buf.length, body: streamOf(buf) }),
    ).rejects.toThrow(/not found/i);
    await expect(
      files.upload({ actorUserId: mallory.userId, organizationId: mallory.orgId, projectId: project.id, filename: "x.pdf", declaredSize: buf.length, body: streamOf(buf) }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("roles and permissions", () => {
  it("project roles control what members can do; finance access is separate", async () => {
    const owner = await createUser("Owner");
    await setPlan(owner.orgId, "research_team");
    const supervisor = await createUser("Supervisor");
    const finance = await createUser("Finance");
    const db = testDb();
    const { projects, files } = fileServices();

    await addMemberByEmail(db, owner.userId, owner.orgId, supervisor.email, "org_member");
    await addMemberByEmail(db, owner.userId, owner.orgId, finance.email, "org_finance_manager");
    const project = await projects.create(owner.userId, owner.orgId, { title: "Shared project", researchType: "journal_article" });

    // Org member without project membership cannot see the project.
    await expect(projects.get(supervisor.userId, project.id)).rejects.toThrow(/not found/i);
    await db.insert(projectMembers).values({ projectId: project.id, userId: supervisor.userId, roleKey: "project_supervisor" });

    const sup = await getProjectAccess(db, supervisor.userId, project.id);
    expect(sup.permissions.has("project.review")).toBe(true);
    expect(sup.permissions.has("project.update")).toBe(false);
    expect(sup.permissions.has("finance.read")).toBe(false);
    await expect(projects.update(supervisor.userId, project.id, { title: "Supervisor edit" })).rejects.toThrow(/permission/);
    const buf = pdfBuffer(5000);
    await expect(
      files.upload({ actorUserId: supervisor.userId, organizationId: owner.orgId, projectId: project.id, filename: "s.pdf", declaredSize: buf.length, body: streamOf(buf) }),
    ).rejects.toThrow(/permission/);

    // Org finance manager sees finances on every project but cannot edit research.
    const fin = await getProjectAccess(db, finance.userId, project.id);
    expect(fin.permissions.has("finance.approve")).toBe(true);
    expect(fin.permissions.has("project.update")).toBe(false);
    expect(fin.permissions.has("project.files.read")).toBe(false);

    // Org admin (no finance) cannot see finances.
    await changeMemberRole(db, owner.userId, owner.orgId, supervisor.userId, "org_admin");
    const admin = await getProjectAccess(db, supervisor.userId, project.id);
    expect(admin.permissions.has("project.update")).toBe(true);
    expect(admin.permissions.has("finance.read")).toBe(false);
  });

  it("members cannot escalate beyond their own role or remove the owner", async () => {
    const owner = await createUser("Owner2");
    await setPlan(owner.orgId, "research_team");
    const admin = await createUser("Admin2");
    const researcher = await createUser("Researcher2");
    const db = testDb();
    await addMemberByEmail(db, owner.userId, owner.orgId, admin.email, "org_admin");
    await addMemberByEmail(db, admin.userId, owner.orgId, researcher.email, "org_researcher");

    await expect(addMemberByEmail(db, researcher.userId, owner.orgId, (await createUser()).email, "org_admin")).rejects.toThrow(/permission/);
    await expect(changeMemberRole(db, admin.userId, owner.orgId, researcher.userId, "org_owner")).rejects.toThrow(/Ownership/);
    await expect(removeMember(db, admin.userId, owner.orgId, owner.userId)).rejects.toThrow(/owner cannot be removed/);
    await removeMember(db, researcher.userId, owner.orgId, researcher.userId); // leaving is allowed
    const orgs = await listUserOrganizations(db, researcher.userId);
    expect(orgs.find((o) => o.id === owner.orgId)).toBeUndefined();
  });

  it("member limits follow the plan", async () => {
    const owner = await createUser("Solo");
    const other = await createUser("Other");
    await expect(addMemberByEmail(testDb(), owner.userId, owner.orgId, other.email, "org_researcher")).rejects.toThrow(/allows 1 member/);
  });
});
