import { type DbOrTx, organizationMembers, organizations, type PermissionKey, PERMISSIONS, projectMembers, researchProjects, rolePermissions, roles } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Role → permission grants are read from the database and cached briefly per
 * process. Permission changes made by administrators take effect within
 * CACHE_TTL_MS without a restart.
 */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; grants: Map<string, Set<PermissionKey>>; ranks: Map<string, { rank: number; scope: string }> } | undefined;

export function clearPermissionCache(): void {
  cache = undefined;
}

async function grants(db: DbOrTx) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  const rows = await db.select({ roleKey: rolePermissions.roleKey, permissionKey: rolePermissions.permissionKey }).from(rolePermissions);
  const roleRows = await db.select({ key: roles.key, rank: roles.rank, scope: roles.scope }).from(roles);
  const map = new Map<string, Set<PermissionKey>>();
  for (const r of rows) {
    if (!map.has(r.roleKey)) map.set(r.roleKey, new Set());
    map.get(r.roleKey)!.add(r.permissionKey as PermissionKey);
  }
  cache = { at: Date.now(), grants: map, ranks: new Map(roleRows.map((r) => [r.key, { rank: r.rank, scope: r.scope }])) };
  return cache;
}

export async function permissionsForRole(db: DbOrTx, roleKey: string): Promise<Set<PermissionKey>> {
  return new Set((await grants(db)).grants.get(roleKey) ?? []);
}

export async function roleInfo(db: DbOrTx, roleKey: string): Promise<{ rank: number; scope: string } | undefined> {
  return (await grants(db)).ranks.get(roleKey);
}

const PROJECT_SCOPED = new Set<PermissionKey>(
  (Object.keys(PERMISSIONS) as PermissionKey[]).filter((k) => k.startsWith("project.") || k.startsWith("finance.")),
);

export interface OrgAccess {
  organizationId: string;
  organizationName: string;
  organizationKind: string;
  roleKey: string;
  permissions: Set<PermissionKey>;
}

/**
 * Returns the caller's access to an organization. Non-members receive
 * NOT_FOUND (not FORBIDDEN) so organization existence is not disclosed.
 */
export async function getOrgAccess(db: DbOrTx, userId: string, organizationId: string): Promise<OrgAccess> {
  const [row] = await db
    .select({ roleKey: organizationMembers.roleKey, name: organizations.name, kind: organizations.kind })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        isNull(organizations.deletedAt),
      ),
    );
  if (!row) throw new AppError("NOT_FOUND", "Organization not found.");
  return {
    organizationId,
    organizationName: row.name,
    organizationKind: row.kind,
    roleKey: row.roleKey,
    permissions: await permissionsForRole(db, row.roleKey),
  };
}

export async function requireOrgPermission(db: DbOrTx, userId: string, organizationId: string, permission: PermissionKey): Promise<OrgAccess> {
  const access = await getOrgAccess(db, userId, organizationId);
  if (!access.permissions.has(permission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to do that in this organization.", { permission });
  }
  return access;
}

export interface ProjectAccess {
  projectId: string;
  organizationId: string;
  orgRoleKey: string;
  projectRoleKey: string | null;
  permissions: Set<PermissionKey>;
}

/**
 * Effective project permissions:
 *   project-scoped permissions from the organization role
 *   ∪ permissions from the project role (if the user is a project member).
 * Requires organization membership; callers without "project.read" get
 * NOT_FOUND so project existence is not disclosed across tenants.
 */
export async function getProjectAccess(db: DbOrTx, userId: string, projectId: string): Promise<ProjectAccess> {
  const [project] = await db
    .select({ id: researchProjects.id, organizationId: researchProjects.organizationId })
    .from(researchProjects)
    .where(eq(researchProjects.id, projectId));
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");

  let org: OrgAccess;
  try {
    org = await getOrgAccess(db, userId, project.organizationId);
  } catch {
    throw new AppError("NOT_FOUND", "Project not found.");
  }

  const [member] = await db
    .select({ roleKey: projectMembers.roleKey })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));

  const effective = new Set<PermissionKey>();
  for (const p of org.permissions) if (PROJECT_SCOPED.has(p)) effective.add(p);
  if (member) for (const p of await permissionsForRole(db, member.roleKey)) effective.add(p);

  if (!effective.has("project.read")) throw new AppError("NOT_FOUND", "Project not found.");
  return {
    projectId,
    organizationId: project.organizationId,
    orgRoleKey: org.roleKey,
    projectRoleKey: member?.roleKey ?? null,
    permissions: effective,
  };
}

export async function requireProjectPermission(db: DbOrTx, userId: string, projectId: string, permission: PermissionKey): Promise<ProjectAccess> {
  const access = await getProjectAccess(db, userId, projectId);
  if (!access.permissions.has(permission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to do that in this project.", { permission });
  }
  return access;
}
