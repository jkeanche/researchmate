import { createInterface } from "node:readline/promises";
import { hashPassword, normaliseEmail, validatePassword } from "@researchmate/auth";
import { closeDb, getDb, securityEvents, userProfiles, users } from "@researchmate/database";
import { env } from "@researchmate/shared";
import { createOrganization } from "@researchmate/tenancy";
import { eq } from "drizzle-orm";

/**
 * Creates (or promotes) a platform administrator.
 *
 *   pnpm admin:create                       interactive
 *   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… pnpm admin:create
 *
 * Existing users are promoted without changing their password.
 */
async function main() {
  env();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, envKey: string) => process.env[envKey] ?? (await rl.question(q));
  const email = normaliseEmail(await ask("Admin email: ", "ADMIN_EMAIL"));
  const db = getDb();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    await db.update(users).set({ isPlatformAdmin: true, updatedAt: new Date() }).where(eq(users.id, existing.id));
    await db.insert(securityEvents).values({ userId: existing.id, type: "admin.promoted", metadata: { via: "cli" } });
    console.log(`Promoted ${email} to platform administrator.`);
    rl.close();
    return;
  }

  const name = (await ask("Admin name: ", "ADMIN_NAME")).trim() || "Administrator";
  const password = await ask("Password (min 10 chars): ", "ADMIN_PASSWORD");
  rl.close();
  validatePassword(password, email);
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ email, passwordHash, emailVerifiedAt: new Date(), isPlatformAdmin: true }).returning({ id: users.id });
    await tx.insert(userProfiles).values({ userId: u!.id, displayName: name });
    await createOrganization(tx, { ownerUserId: u!.id, name: `${name.split(" ")[0]}'s workspace`, kind: "personal" });
    await tx.insert(securityEvents).values({ userId: u!.id, type: "admin.created", metadata: { via: "cli" } });
  });
  console.log(`Created platform administrator ${email}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
