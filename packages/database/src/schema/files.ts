import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "set null" }),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    originalName: text("original_name").notNull(),
    /** MIME type detected from file content (never trusted from the client). */
    mimeType: text("mime_type").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    /**
     * stored     — original saved, no processing requested (e.g. Free plan)
     * pending / processing / processed / failed — extraction pipeline states
     */
    processingStatus: text("processing_status").notNull().default("stored"),
    /** Snapshot of whether the organization was entitled to AI processing at upload time. */
    aiProcessingAllowed: boolean("ai_processing_allowed").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("files_org_idx").on(t.organizationId).where(sql`${t.deletedAt} is null`),
    index("files_project_idx").on(t.projectId),
    check(
      "files_processing_status_check",
      sql`${t.processingStatus} in ('stored', 'pending', 'processing', 'processed', 'failed')`,
    ),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Set when the stored object has been physically removed after retention. */
    purgedAt: ts("purged_at"),
  },
  (t) => [
    uniqueIndex("file_versions_file_version_unique").on(t.fileId, t.version),
    uniqueIndex("file_versions_storage_key_unique").on(t.storageKey),
    check("file_versions_size_check", sql`${t.sizeBytes} >= 0`),
  ],
);

/**
 * Quota reservations held while an upload is in flight. Reserved bytes count
 * against the organization's quota until committed or released, which makes
 * concurrent uploads safe.
 */
export const fileStorageReservations = pgTable(
  "file_storage_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    /** Whether this reservation also holds one slot of the file-count quota (false for new versions). */
    countsAsFile: boolean("counts_as_file").notNull().default(true),
    status: text("status").notNull().default("active"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    index("reservations_org_active_idx").on(t.organizationId).where(sql`${t.status} = 'active'`),
    check("reservations_status_check", sql`${t.status} in ('active', 'committed', 'released', 'expired')`),
    check("reservations_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

export const fileProcessingJobs = pgTable(
  "file_processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    fileVersion: integer("file_version").notNull(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("file_processing_jobs_file_idx").on(t.fileId),
    check("file_processing_jobs_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`),
  ],
);
