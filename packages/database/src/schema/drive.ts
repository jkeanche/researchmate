import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { files } from "./files";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** OAuth connections. Tokens are AES-256-GCM encrypted and never sent to the browser. */
export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accountEmail: text("account_email").notNull().default(""),
    scopes: text("scopes").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    connectedAt: ts("connected_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("connected_accounts_live_idx").on(t.userId, t.organizationId, t.provider).where(sql`${t.revokedAt} is null`),
    check("connected_accounts_status_check", sql`${t.status} in ('active', 'reauth_required', 'revoked')`),
  ],
);

/**
 * A Drive file known to ResearchMate. A reference alone uses no managed
 * storage; only an imported copy (imported_file_id) counts against quota.
 */
export const externalFileReferences = pgTable(
  "external_file_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "set null" }),
    connectedAccountId: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    md5: text("md5"),
    externalModifiedAt: ts("external_modified_at"),
    webViewLink: text("web_view_link"),
    importedFileId: uuid("imported_file_id").references(() => files.id, { onDelete: "set null" }),
    importedVersionMd5: text("imported_version_md5"),
    importedModifiedAt: ts("imported_modified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("external_file_references_ext_idx").on(t.organizationId, t.provider, t.externalId)],
);

/** Import and export jobs (drive_import_jobs / drive_export_jobs in the blueprint). */
export const driveJobs = pgTable(
  "drive_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    connectedAccountId: uuid("connected_account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    /** import: { externalId } · export: { fileId, folderId?, exportAs? } */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("drive_jobs_user_idx").on(t.userId, t.createdAt),
    check("drive_jobs_kind_check", sql`${t.kind} in ('import', 'export')`),
    check("drive_jobs_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
  ],
);
