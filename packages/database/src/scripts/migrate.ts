import { closeDb, getDb } from "../client";
import { runMigrations } from "../migrate";
import { seedReferenceData } from "../seed";

/** Applies pending migrations, then synchronises reference data (roles, permissions, plans). */
async function main() {
  const db = getDb();
  await runMigrations(db);
  console.log("Migrations applied.");
  await seedReferenceData(db);
  console.log("Reference data synchronised.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
