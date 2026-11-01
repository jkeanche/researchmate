import {
  type Database,
  type DbOrTx,
  organizationMembers,
  organizations,
  plans,
  subscriptions,
  userProfiles,
  users,
} from "@researchmate/database";
import { checkMemberQuota, lockOrganization } from "@researchmate/entitlements";
import { AppError, randomToken } from "@researchmate/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { getOrgAccess, requireOrgPermission, roleInfo } from "./permissions";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${base || "org"}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "x"}`;
}

export function validateOrgName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 80) throw new AppError("VALIDATION", "Organization name must be 2–80 characters.");
  return trimmed;
}

/**
 * Number of organizations the user owns that are on a free (zero-price)
 * plan or have no live subscription. Users may own at most one, which stops
 * free-plan limits being multiplied by creating extra organizations.
 */
async function countOwnedFreeOrganizations(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from ${organizations} o
    left join ${subscriptions} s
      on s.organization_id = o.id and s.status in ('active', 'trialing', 'past_due')
    left join ${plans} p on p.id = s.plan_id
    where o.owner_user_id = ${userId}
      and o.deleted_at is null
      and (s.id is null or p.price_minor = 0)
  `);
  return Number(rows[0]?.n ?? 0);
}

export const MAX_OWNED_FREE_ORGANIZATIONS = 1;

export interface CreateOrganizationInput {
  ownerUserId: string;
  name: string;
  kind: "personal" | "team";
}

/**
 * Creates an organization, makes the creator its owner and starts a
 * subscription on the default plan. Must be called inside a transaction.
 */
export async function createOrganization(tx: DbOrTx, input: CreateOrganizationInput) {
  const name = validateOrgName(input.name);
  // Serialise organization creation per user to make the free-org check race-free.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('org-create'), hashtext(${input.ownerUserId}))`);

  if ((await countOwnedFreeOrganizations(tx, input.ownerUserId)) >= MAX_OWNED_FREE_ORGANIZATIONS) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "You already own an organization on the Free plan. Upgrade it, or ask an administrator, before creating another.",
      { feature: "organizations.free_owned" },
    );
  }

  const [defaultPlan] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.isDefault, true)).limit(1);
  if (!defaultPlan) throw new AppError("INTERNAL", "No default plan configured.");

  const [org] = await tx
    .insert(organizations)
    .values({ name, slug: slugify(name), kind: input.kind, ownerUserId: input.ownerUserId })
    .returning();
  if (!org) throw new AppError("INTERNAL", "Could not create organization.");

  await tx.insert(organizationMembers).values({ organizationId: org.id, userId: input.ownerUserId, roleKey: "org_owner" });
  await tx.insert(subscriptions).values({ organizationId: org.id, planId: defaultPlan.id, status: "active", provider: "manual" });
  await recordAudit(tx, {
    organizationId: org.id,
    actorUserId: input.ownerUserId,
    action: "organization.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { kind: input.kind },
  });
  return org;
}

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  kind: string;
  roleKey: string;
  planName: string | null;
}

export async function listUserOrganizations(db: DbOrTx, userId: string): Promise<UserOrganization[]> {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      kind: organizations.kind,
      roleKey: organizationMembers.roleKey,
      planName: plans.name,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .leftJoin(
      subscriptions,
      and(eq(subscriptions.organizationId, organizations.id), inArray(subscriptions.status, ["active", "trialing", "past_due"])),
    )
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.kind), asc(organizations.createdAt));
}

export async function listMembers(db: DbOrTx, actorUserId: string, organizationId: string) {
  await getOrgAccess(db, actorUserId, organizationId);
  return db
    .select({
      userId: users.id,
      email: users.email,
      displayName: userProfiles.displayName,
      roleKey: organizationMembers.roleKey,
      joinedAt: organizationMembers.joinedAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(asc(organizationMembers.joinedAt));
}

async function assertAssignableRole(db: DbOrTx, actorRoleKey: string, roleKey: string) {
  const target = await roleInfo(db, roleKey);
  const actor = await roleInfo(db, actorRoleKey);
  if (!target || target.scope === "project") throw new AppError("VALIDATION", "Unknown organization role.");
  if (roleKey === "org_owner") throw new AppError("FORBIDDEN", "Ownership transfer is a separate, explicit operation.");
  if (!actor || target.rank > actor.rank) throw new AppError("FORBIDDEN", "You cannot grant a role above your own.");
}

/**
 * Adds an existing, verified user to the organization. (Email invitations for
 * people without an account arrive with the collaboration milestone.)
 */
export async function addMemberByEmail(db: Database, actorUserId: string, organizationId: string, email: string, roleKey: string) {
  return db.transaction(async (tx) => {
    const actor = await requireOrgPermission(tx, actorUserId, organizationId, "org.members.manage");
    await assertAssignableRole(tx, actor.roleKey, roleKey);
    await lockOrganization(tx, organizationId);
    const [user] = await tx.select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt, status: users.status }).from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || user.status !== "active") {
      throw new AppError("NOT_FOUND", "No active ResearchMate account uses that email. Ask them to register first.");
    }
    const [existing] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, user.id)));
    if (existing) throw new AppError("CONFLICT", "That person is already a member.");
    await checkMemberQuota(tx, organizationId);
    await tx.insert(organizationMembers).values({ organizationId, userId: user.id, roleKey });
    await recordAudit(tx, { organizationId, actorUserId, action: "organization.member_added", targetType: "user", targetId: user.id, metadata: { roleKey } });
    return { userId: user.id };
  });
}

export async function changeMemberRole(db: Database, actorUserId: string, organizationId: string, memberUserId: string, roleKey: string) {
  return db.transaction(async (tx) => {
    const actor = await requireOrgPermission(tx, actorUserId, organizationId, "org.members.manage");
    await assertAssignableRole(tx, actor.roleKey, roleKey);
    const [member] = await tx
      .select({ roleKey: organizationMembers.roleKey })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, memberUserId)));
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    if (member.roleKey === "org_owner") throw new AppError("FORBIDDEN", "The owner's role cannot be changed.");
    const memberRank = (await roleInfo(tx, member.roleKey))?.rank ?? 0;
    const actorRank = (await roleInfo(tx, actor.roleKey))?.rank ?? 0;
    if (memberRank > actorRank) throw new AppError("FORBIDDEN", "You cannot change the role of a more senior member.");
    await tx
      .update(organizationMembers)
      .set({ roleKey })
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, memberUserId)));
    await recordAudit(tx, { organizationId, actorUserId, action: "organization.member_role_changed", targetType: "user", targetId: memberUserId, metadata: { from: member.roleKey, to: roleKey } });
  });
}

export async function removeMember(db: Database, actorUserId: string, organizationId: string, memberUserId: string) {
  return db.transaction(async (tx) => {
    const isSelf = actorUserId === memberUserId;
    const actor = isSelf ? await getOrgAccess(tx, actorUserId, organizationId) : await requireOrgPermission(tx, actorUserId, organizationId, "org.members.manage");
    const [member] = await tx
      .select({ roleKey: organizationMembers.roleKey })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, memberUserId)));
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    if (member.roleKey === "org_owner") throw new AppError("FORBIDDEN", "The owner cannot be removed. Transfer ownership first.");
    if (!isSelf) {
      const memberRank = (await roleInfo(tx, member.roleKey))?.rank ?? 0;
      const actorRank = (await roleInfo(tx, actor.roleKey))?.rank ?? 0;
      if (memberRank > actorRank) throw new AppError("FORBIDDEN", "You cannot remove a more senior member.");
    }
    await tx
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, memberUserId)));
    await recordAudit(tx, { organizationId, actorUserId, action: isSelf ? "organization.member_left" : "organization.member_removed", targetType: "user", targetId: memberUserId });
  });
}
