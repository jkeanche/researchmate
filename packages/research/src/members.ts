import { type Database, organizationMembers, projectMembers, researchProjects, roles, userProfiles, users } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { getProjectAccess, recordAudit, requireProjectPermission, roleInfo } from "@researchmate/tenancy";
import { and, asc, eq } from "drizzle-orm";
import { assertProjectWritable } from "./content";

/**
 * Project membership: which organization members work on a project, and in
 * which project role. Only existing organization members can be added.
 */
export class ProjectMemberService {
  constructor(private readonly db: Database) {}

  async list(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const members = await this.db
      .select({ userId: projectMembers.userId, roleKey: projectMembers.roleKey, roleName: roles.name, displayName: userProfiles.displayName, email: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .innerJoin(roles, eq(roles.key, projectMembers.roleKey))
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(asc(userProfiles.displayName));
    const candidates = access.permissions.has("project.members.manage")
      ? (
          await this.db
            .select({ userId: users.id, displayName: userProfiles.displayName, email: users.email })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
            .where(eq(organizationMembers.organizationId, access.organizationId))
        ).filter((c) => !members.some((m) => m.userId === c.userId))
      : [];
    const projectRoles = await this.db.select({ key: roles.key, name: roles.name, description: roles.description }).from(roles).where(eq(roles.scope, "project")).orderBy(asc(roles.rank));
    return { access, members, candidates, roles: projectRoles.reverse() };
  }

  /**
   * People who can be assigned work: project members plus organization members
   * whose organization role already grants access to every project.
   */
  async assignable(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    const orgMembers = await this.db
      .select({ userId: users.id, displayName: userProfiles.displayName, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(organizationMembers.organizationId, access.organizationId));
    const out: { userId: string; displayName: string; email: string }[] = [];
    for (const m of orgMembers) {
      const ok = await getProjectAccess(this.db, m.userId, projectId).then(
        () => true,
        () => false,
      );
      if (ok) out.push({ userId: m.userId, displayName: m.displayName ?? m.email, email: m.email });
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async add(actorUserId: string, projectId: string, userId: string, roleKey: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.members.manage");
    await assertProjectWritable(this.db, projectId);
    const info = await roleInfo(this.db, roleKey);
    if (!info || info.scope !== "project") throw new AppError("VALIDATION", "Unknown project role.");
    const [member] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, access.organizationId), eq(organizationMembers.userId, userId)));
    if (!member) throw new AppError("VALIDATION", "Only members of this organization can be added to the project.");
    await this.db.transaction(async (tx) => {
      await tx.select({ id: researchProjects.id }).from(researchProjects).where(eq(researchProjects.id, projectId)).for("update");
      if (roleKey !== "project_lead") {
        const leads = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.roleKey, "project_lead")));
        if (leads.length === 1 && leads[0]!.userId === userId) throw new AppError("VALIDATION", "A project needs at least one lead researcher.");
      }
      await tx
        .insert(projectMembers)
        .values({ projectId, userId, roleKey })
        .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleKey } });
    });
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "project.member.set", targetType: "project", targetId: projectId, metadata: { userId, roleKey } });
  }

  async remove(actorUserId: string, projectId: string, userId: string) {
    const access = await requireProjectPermission(this.db, actorUserId, projectId, "project.members.manage");
    await assertProjectWritable(this.db, projectId);
    await this.db.transaction(async (tx) => {
      await tx.select({ id: researchProjects.id }).from(researchProjects).where(eq(researchProjects.id, projectId)).for("update");
      const leads = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.roleKey, "project_lead")));
      if (leads.length === 1 && leads[0]!.userId === userId) throw new AppError("VALIDATION", "A project needs at least one lead researcher.");
      await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    });
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "project.member.removed", targetType: "project", targetId: projectId, metadata: { userId } });
  }
}
