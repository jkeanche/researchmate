import { eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { PLAN_SEEDS } from "./catalog/features";
import { PERMISSIONS, ROLE_SEEDS } from "./catalog/rbac";
import { permissions, planEntitlements, plans, rolePermissions, roles } from "./schema";

/**
 * Idempotent reference-data seed: permissions, roles, role grants and plans.
 *
 * Role/permission grants are synchronised to the catalogue. Plans are inserted
 * if missing; existing plan prices and entitlement values are NOT overwritten,
 * so administrators can tune them in the database. Missing entitlement keys
 * are added with seed defaults.
 */
export async function seedReferenceData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [key, p] of Object.entries(PERMISSIONS)) {
      await tx
        .insert(permissions)
        .values({ key, description: p.description, domain: p.domain })
        .onConflictDoUpdate({ target: permissions.key, set: { description: p.description, domain: p.domain } });
    }

    for (const r of ROLE_SEEDS) {
      await tx
        .insert(roles)
        .values({ key: r.key, name: r.name, description: r.description, scope: r.scope, rank: r.rank })
        .onConflictDoUpdate({
          target: roles.key,
          set: { name: r.name, description: r.description, scope: r.scope, rank: r.rank },
        });
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleKey, r.key));
      if (r.permissions.length) {
        await tx.insert(rolePermissions).values([...new Set(r.permissions)].map((p) => ({ roleKey: r.key, permissionKey: p })));
      }
    }

    for (const p of PLAN_SEEDS) {
      const [row] = await tx
        .insert(plans)
        .values({
          key: p.key,
          name: p.name,
          description: p.description,
          priceMinor: p.priceMinor,
          sortOrder: p.sortOrder,
          isDefault: p.isDefault ?? false,
        })
        .onConflictDoUpdate({ target: plans.key, set: { updatedAt: sql`${plans.updatedAt}` } })
        .returning({ id: plans.id });
      if (!row) throw new Error(`Failed to upsert plan ${p.key}`);
      for (const [featureKey, value] of Object.entries(p.entitlements)) {
        await tx.insert(planEntitlements).values({ planId: row.id, featureKey, value }).onConflictDoNothing();
      }
    }
  });
}
