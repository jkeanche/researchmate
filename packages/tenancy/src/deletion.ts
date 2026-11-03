import { type DbOrTx, organizationMembers, organizations } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notify } from "./notifications";

export const DEFAULT_DELETION_GRACE_DAYS = 30;

/**
 * Schedules an organization for deletion (§29 retention). Only the owner can
 * do this, after typing the organization's name. Members lose access at once;
 * the owner can restore it until `purgeAfter`, when the purge job removes its
 * research content and keeps only financial records.
 */
export async function scheduleOrganizationDeletion(db: DbOrTx, actorUserId: string, organizationId: string, confirmName: string, graceDays = DEFAULT_DELETION_GRACE_DAYS) {
  const [org] = await db.select().from(organizations).where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)));
  if (!org) throw new AppError("NOT_FOUND", "Organization not found.");
  if (org.ownerUserId !== actorUserId) throw new AppError("FORBIDDEN", "Only the organization's owner can delete it.");
  if (confirmName.trim() !== org.name) throw new AppError("VALIDATION", "Type the organization's name exactly to confirm.");
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + graceDays * 86_400_000);
  const members = await db.select({ u: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), ne(organizationMembers.userId, actorUserId)));
  await db.update(organizations).set({ deletedAt: now, purgeAfter, updatedAt: now }).where(eq(organizations.id, organizationId));
  await recordAudit(db, { organizationId, actorUserId, action: "organization.deletion_scheduled", targetType: "organization", targetId: organizationId, metadata: { purgeAfter: purgeAfter.toISOString() } });
  await notify(db, { userIds: [actorUserId], kind: "security.alert", title: `“${org.name}” is scheduled for deletion`, body: `The workspace “${org.name}” and its projects will be permanently deleted on ${purgeAfter.toISOString().slice(0, 10)}. You can restore it until then from Settings → Profile. Invoices are kept for accounting.`, link: "/app/settings/profile" });
  await notify(db, { userIds: members.map((m) => m.u), kind: "security.alert", title: `“${org.name}” was deleted by its owner`, body: `You no longer have access to the workspace “${org.name}”. Its content will be permanently deleted on ${purgeAfter.toISOString().slice(0, 10)} unless the owner restores it.`, link: "/app/settings/profile" });
  return { purgeAfter };
}

/** Restores a scheduled deletion before the purge has started. Owner only. */
export async function restoreOrganization(db: DbOrTx, actorUserId: string, organizationId: string) {
  const [row] = await db
    .update(organizations)
    .set({ deletedAt: null, purgeAfter: null, updatedAt: new Date() })
    .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, actorUserId), isNotNull(organizations.deletedAt), isNull(organizations.purgeStartedAt)))
    .returning();
  if (!row) throw new AppError("NOT_FOUND", "There is no deleted organization of yours to restore.");
  await recordAudit(db, { organizationId, actorUserId, action: "organization.restored", targetType: "organization", targetId: organizationId });
  return row;
}

/** Organizations the user owns that are waiting to be purged. */
export async function listScheduledDeletions(db: DbOrTx, userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name, deletedAt: organizations.deletedAt, purgeAfter: organizations.purgeAfter })
    .from(organizations)
    .where(and(eq(organizations.ownerUserId, userId), isNotNull(organizations.deletedAt), isNull(organizations.purgeStartedAt)))
    .orderBy(sql`${organizations.purgeAfter} asc`);
}
