import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client";

export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function runMigrations(db: Database, folder = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
