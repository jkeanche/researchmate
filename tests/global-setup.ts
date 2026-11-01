import postgres from "postgres";
import { createDatabase, runMigrations, seedReferenceData } from "@researchmate/database";

/** Recreates the test schema from migrations once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/researchmate_test";
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await admin.end();
  const { db, sql } = createDatabase(url, { max: 2 });
  await runMigrations(db);
  await seedReferenceData(db);
  await sql.end();
}
