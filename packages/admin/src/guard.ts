import { type DbOrTx, users } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { and, eq } from "drizzle-orm";

/**
 * Every administration method checks the database itself rather than trusting
 * a flag carried in the session, so revoking someone's administrator role (or
 * disabling them) takes effect on their very next request.
 */
export async function requirePlatformAdmin(db: DbOrTx, userId: string): Promise<{ id: string; email: string }> {
  const [u] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isPlatformAdmin, true), eq(users.status, "active")));
  if (!u) throw new AppError("FORBIDDEN", "Platform administrators only.");
  return u;
}

export async function isPlatformAdmin(db: DbOrTx, userId: string): Promise<boolean> {
  try {
    await requirePlatformAdmin(db, userId);
    return true;
  } catch {
    return false;
  }
}
