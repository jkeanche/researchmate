import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __rmSql?: postgres.Sql; __rmDb?: Database };

export function createDatabase(url: string, opts: { max?: number } = {}): { db: Database; sql: postgres.Sql } {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema, casing: "snake_case" }), sql };
}

/**
 * Process-wide database handle. Cached on globalThis so Next.js hot reload
 * does not leak connection pools.
 */
export function getDb(): Database {
  if (!globalForDb.__rmDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const { db, sql } = createDatabase(url);
    globalForDb.__rmDb = db;
    globalForDb.__rmSql = sql;
  }
  return globalForDb.__rmDb;
}

export async function closeDb(): Promise<void> {
  await globalForDb.__rmSql?.end({ timeout: 5 });
  globalForDb.__rmSql = undefined;
  globalForDb.__rmDb = undefined;
}
