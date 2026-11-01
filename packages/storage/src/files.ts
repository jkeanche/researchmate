import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type Database,
  type DbOrTx,
  fileStorageReservations,
  files,
  fileVersions,
  researchProjects,
  userProfiles,
} from "@researchmate/database";
import { checkUploadQuota, featureEnabled, lockOrganization } from "@researchmate/entitlements";
import { AppError, logger } from "@researchmate/shared";
import { getOrgAccess, getProjectAccess, recordAudit, requireOrgPermission, requireProjectPermission } from "@researchmate/tenancy";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { detectContentType, sanitizeFilename, UnsupportedFileTypeError } from "./content-type";
import { type StorageDriver, UploadTooLargeError } from "./driver";

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export interface FileServiceDeps {
  db: Database;
  driver: StorageDriver;
  /** Platform-wide ceiling (MAX_UPLOAD_SIZE_MB), applied on top of plan limits. */
  maxUploadBytes: number;
}

export interface UploadInput {
  actorUserId: string;
  organizationId: string;
  projectId?: string | null;
  filename: string;
  /** Exact byte length announced by the client (Content-Length). Required so quota can be reserved up front. */
  declaredSize: number;
  body: Readable | AsyncIterable<Uint8Array>;
}

export interface NewVersionInput {
  actorUserId: string;
  fileId: string;
  filename: string;
  declaredSize: number;
  body: Readable | AsyncIterable<Uint8Array>;
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** Storage key: opaque, tenant-prefixed, never derived from the filename. */
  private newKey(organizationId: string): string {
    const d = new Date();
    return `${organizationId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  }

  /**
   * Reserves quota inside a transaction holding the organization lock, so two
   * concurrent uploads can never both pass the same quota check.
   */
  private async reserve(organizationId: string, userId: string, sizeBytes: number, newFile: boolean) {
    return this.db.transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      const ent = await checkUploadQuota(tx, organizationId, { sizeBytes, newFile });
      const [reservation] = await tx
        .insert(fileStorageReservations)
        .values({
          organizationId,
          userId,
          bytes: sizeBytes,
          countsAsFile: newFile,
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        })
        .returning({ id: fileStorageReservations.id });
      return { reservationId: reservation!.id, aiProcessingAllowed: featureEnabled(ent, "ai.document_processing") };
    });
  }

  private async release(reservationId: string) {
    await this.db
      .update(fileStorageReservations)
      .set({ status: "released", resolvedAt: new Date() })
      .where(and(eq(fileStorageReservations.id, reservationId), eq(fileStorageReservations.status, "active")));
  }

  private validateSize(declaredSize: number) {
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new AppError("VALIDATION", "The upload must include its exact size (Content-Length).");
    }
    if (declaredSize === 0) throw new AppError("VALIDATION", "The file is empty.");
    if (declaredSize > this.deps.maxUploadBytes) {
      throw new AppError("QUOTA_EXCEEDED", `Files can be at most ${Math.floor(this.deps.maxUploadBytes / 1024 / 1024)} MB.`);
    }
  }

  /** Streams the body into storage, verifying size, then content type. Cleans up on any failure. */
  private async store(organizationId: string, filename: string, declaredSize: number, body: UploadInput["body"]) {
    const key = this.newKey(organizationId);
    let put;
    try {
      put = await this.deps.driver.put(key, body, { maxBytes: declaredSize });
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw new AppError("VALIDATION", "The upload is larger than its declared size.");
      throw err;
    }
    try {
      if (put.sizeBytes !== declaredSize) throw new AppError("VALIDATION", "The upload was incomplete. Please try again.");
      const mimeType = await detectContentType(filename, put.head);
      return { key, mimeType, sizeBytes: put.sizeBytes, checksumSha256: put.checksumSha256 };
    } catch (err) {
      await this.deps.driver.delete(key).catch(() => {});
      if (err instanceof UnsupportedFileTypeError) throw new AppError("VALIDATION", err.message);
      throw err;
    }
  }

  async upload(input: UploadInput) {
    const filename = this.cleanName(input.filename);
    this.validateSize(input.declaredSize);

    if (input.projectId) {
      const access = await requireProjectPermission(this.db, input.actorUserId, input.projectId, "project.files.write");
      if (access.organizationId !== input.organizationId) throw new AppError("NOT_FOUND", "Project not found.");
      await this.assertProjectWritable(input.projectId);
    } else {
      await requireOrgPermission(this.db, input.actorUserId, input.organizationId, "files.upload");
    }

    const { reservationId, aiProcessingAllowed } = await this.reserve(input.organizationId, input.actorUserId, input.declaredSize, true);
    let stored: Awaited<ReturnType<FileService["store"]>> | undefined;
    try {
      stored = await this.store(input.organizationId, filename, input.declaredSize, input.body);
      const s = stored;
      const file = await this.db.transaction(async (tx) => {
        const [f] = await tx
          .insert(files)
          .values({
            organizationId: input.organizationId,
            projectId: input.projectId ?? null,
            uploadedByUserId: input.actorUserId,
            originalName: filename,
            mimeType: s.mimeType,
            currentVersion: 1,
            // Processing (extraction/OCR/embeddings) is introduced in a later milestone.
            // Until then every upload is stored only; no background AI work is queued.
            processingStatus: "stored",
            aiProcessingAllowed,
          })
          .returning();
        await tx.insert(fileVersions).values({
          fileId: f!.id,
          version: 1,
          sizeBytes: s.sizeBytes,
          checksumSha256: s.checksumSha256,
          storageDriver: this.deps.driver.name,
          storageKey: s.key,
          mimeType: s.mimeType,
          createdByUserId: input.actorUserId,
        });
        const committed = await tx
          .update(fileStorageReservations)
          .set({ status: "committed", resolvedAt: new Date() })
          .where(and(eq(fileStorageReservations.id, reservationId), eq(fileStorageReservations.status, "active")))
          .returning({ id: fileStorageReservations.id });
        if (committed.length === 0) throw new AppError("CONFLICT", "The upload took too long and its reservation expired. Please try again.");
        await recordAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: "file.uploaded",
          targetType: "file",
          targetId: f!.id,
          metadata: { projectId: input.projectId ?? null, sizeBytes: s.sizeBytes, mimeType: s.mimeType },
        });
        return f!;
      });
      return file;
    } catch (err) {
      await this.release(reservationId);
      if (stored) await this.deps.driver.delete(stored.key).catch((e) => logger.error("storage.cleanup_failed", { error: String(e) }));
      throw err;
    }
  }

  async uploadNewVersion(input: NewVersionInput) {
    const filename = this.cleanName(input.filename);
    this.validateSize(input.declaredSize);
    const file = await this.requireFileAccess(input.actorUserId, input.fileId, "write");
    if (filename.split(".").pop()?.toLowerCase() !== file.originalName.split(".").pop()?.toLowerCase()) {
      throw new AppError("VALIDATION", "A new version must have the same file type as the original.");
    }
    const { reservationId } = await this.reserve(file.organizationId, input.actorUserId, input.declaredSize, false);
    let stored: Awaited<ReturnType<FileService["store"]>> | undefined;
    try {
      stored = await this.store(file.organizationId, filename, input.declaredSize, input.body);
      const s = stored;
      return await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(files).where(and(eq(files.id, file.id), isNull(files.deletedAt))).for("update");
        if (!locked) throw new AppError("NOT_FOUND", "File not found.");
        const version = locked.currentVersion + 1;
        await tx.insert(fileVersions).values({
          fileId: file.id,
          version,
          sizeBytes: s.sizeBytes,
          checksumSha256: s.checksumSha256,
          storageDriver: this.deps.driver.name,
          storageKey: s.key,
          mimeType: s.mimeType,
          createdByUserId: input.actorUserId,
        });
        const [updated] = await tx
          .update(files)
          .set({ currentVersion: version, mimeType: s.mimeType, updatedAt: new Date() })
          .where(eq(files.id, file.id))
          .returning();
        const committed = await tx
          .update(fileStorageReservations)
          .set({ status: "committed", resolvedAt: new Date() })
          .where(and(eq(fileStorageReservations.id, reservationId), eq(fileStorageReservations.status, "active")))
          .returning({ id: fileStorageReservations.id });
        if (committed.length === 0) throw new AppError("CONFLICT", "The upload took too long and its reservation expired. Please try again.");
        await recordAudit(tx, {
          organizationId: file.organizationId,
          actorUserId: input.actorUserId,
          action: "file.version_uploaded",
          targetType: "file",
          targetId: file.id,
          metadata: { version, sizeBytes: s.sizeBytes },
        });
        return updated!;
      });
    } catch (err) {
      await this.release(reservationId);
      if (stored) await this.deps.driver.delete(stored.key).catch(() => {});
      throw err;
    }
  }

  private cleanName(name: string) {
    try {
      return sanitizeFilename(name);
    } catch (err) {
      throw new AppError("VALIDATION", (err as Error).message);
    }
  }

  private async assertProjectWritable(projectId: string) {
    const [p] = await this.db.select({ status: researchProjects.status }).from(researchProjects).where(eq(researchProjects.id, projectId));
    if (p?.status === "archived") throw new AppError("READ_ONLY", "This project is archived. Restore it to add files.");
  }

  /**
   * Loads a file and checks the caller may read/write/delete it.
   * Project files follow project permissions; library files (no project)
   * are visible to their uploader and to roles with files.read_all.
   */
  async requireFileAccess(userId: string, fileId: string, mode: "read" | "write" | "delete") {
    const [file] = await this.db.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt)));
    if (!file) throw new AppError("NOT_FOUND", "File not found.");
    try {
      if (file.projectId) {
        const perm = mode === "read" ? "project.files.read" : mode === "write" ? "project.files.write" : "project.files.delete";
        await requireProjectPermission(this.db, userId, file.projectId, perm);
        if (mode !== "read") await this.assertProjectWritable(file.projectId);
      } else {
        const org = await getOrgAccess(this.db, userId, file.organizationId);
        const isUploader = file.uploadedByUserId === userId;
        const ok = mode === "read" ? isUploader || org.permissions.has("files.read_all") : isUploader || org.permissions.has("org.settings.manage");
        if (!ok) throw new AppError("FORBIDDEN", "You do not have access to this file.");
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "NOT_FOUND") throw new AppError("NOT_FOUND", "File not found.");
      throw err;
    }
    return file;
  }

  async openForDownload(userId: string, fileId: string, version?: number) {
    const file = await this.requireFileAccess(userId, fileId, "read");
    const [v] = await this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, version ?? file.currentVersion), isNull(fileVersions.purgedAt)));
    if (!v) throw new AppError("NOT_FOUND", "File version not found.");
    if (v.storageDriver !== this.deps.driver.name) {
      throw new AppError("INTERNAL", `This file is stored with the ${v.storageDriver} driver, which is not configured.`);
    }
    const stream = await this.deps.driver.get(v.storageKey);
    return { file, version: v, stream };
  }

  /** Soft delete: the file disappears and stops counting against quota immediately; objects are purged after retention. */
  async delete(userId: string, fileId: string) {
    const file = await this.requireFileAccess(userId, fileId, "delete");
    await this.db.transaction(async (tx) => {
      await tx.update(files).set({ deletedAt: new Date(), deletedByUserId: userId, updatedAt: new Date() }).where(eq(files.id, fileId));
      await recordAudit(tx, { organizationId: file.organizationId, actorUserId: userId, action: "file.deleted", targetType: "file", targetId: fileId, metadata: { name: file.originalName } });
    });
  }

  /** Files visible to the user in an organization (optionally one project). */
  async list(userId: string, organizationId: string, opts: { projectId?: string; limit?: number } = {}) {
    const org = await getOrgAccess(this.db, userId, organizationId);
    let projectFilter;
    if (opts.projectId) {
      const access = await getProjectAccess(this.db, userId, opts.projectId);
      if (access.organizationId !== organizationId || !access.permissions.has("project.files.read")) throw new AppError("NOT_FOUND", "Project not found.");
      projectFilter = eq(files.projectId, opts.projectId);
    } else if (!org.permissions.has("files.read_all")) {
      // Library files the user uploaded, plus files of projects they can read.
      const readable = await this.readableProjectIds(userId, organizationId);
      projectFilter = or(
        and(isNull(files.projectId), eq(files.uploadedByUserId, userId)),
        readable.length ? inArray(files.projectId, readable) : sql`false`,
      );
    }
    return listFilesQuery(this.db, organizationId, projectFilter, opts.limit ?? 200);
  }

  private async readableProjectIds(userId: string, organizationId: string): Promise<string[]> {
    const rows = await this.db.execute<{ id: string }>(sql`
      select p.id from research_projects p
      join project_members pm on pm.project_id = p.id and pm.user_id = ${userId}
      join role_permissions rp on rp.role_key = pm.role_key and rp.permission_key = 'project.files.read'
      where p.organization_id = ${organizationId}
    `);
    return rows.map((r) => r.id);
  }

  async listVersions(userId: string, fileId: string) {
    await this.requireFileAccess(userId, fileId, "read");
    return this.db
      .select({ version: fileVersions.version, sizeBytes: fileVersions.sizeBytes, checksumSha256: fileVersions.checksumSha256, createdAt: fileVersions.createdAt })
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId))
      .orderBy(desc(fileVersions.version));
  }
}

function listFilesQuery(db: DbOrTx, organizationId: string, extra: ReturnType<typeof and> | undefined, limit: number) {
  return db
    .select({
      id: files.id,
      originalName: files.originalName,
      mimeType: files.mimeType,
      projectId: files.projectId,
      projectTitle: researchProjects.title,
      currentVersion: files.currentVersion,
      processingStatus: files.processingStatus,
      createdAt: files.createdAt,
      updatedAt: files.updatedAt,
      uploadedBy: userProfiles.displayName,
      sizeBytes: fileVersions.sizeBytes,
    })
    .from(files)
    .leftJoin(researchProjects, eq(researchProjects.id, files.projectId))
    .leftJoin(userProfiles, eq(userProfiles.userId, files.uploadedByUserId))
    .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
    .where(and(eq(files.organizationId, organizationId), isNull(files.deletedAt), extra))
    .orderBy(desc(files.updatedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Maintenance (run by the worker)
// ---------------------------------------------------------------------------

/** Marks reservations that outlived their TTL as expired, returning quota to the organization. */
export async function expireReservations(db: DbOrTx): Promise<number> {
  const rows = await db
    .update(fileStorageReservations)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(and(eq(fileStorageReservations.status, "active"), lt(fileStorageReservations.expiresAt, sql`now()`)))
    .returning({ id: fileStorageReservations.id });
  return rows.length;
}

/** Physically removes stored objects of files deleted more than `retentionHours` ago. Metadata is kept for audit. */
export async function purgeDeletedFiles(db: DbOrTx, driver: StorageDriver, retentionHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000);
  const rows = await db
    .select({ id: fileVersions.id, key: fileVersions.storageKey, driver: fileVersions.storageDriver })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, cutoff), isNull(fileVersions.purgedAt), eq(fileVersions.storageDriver, driver.name)))
    .limit(500);
  let purged = 0;
  for (const r of rows) {
    await driver.delete(r.key);
    await db.update(fileVersions).set({ purgedAt: new Date() }).where(eq(fileVersions.id, r.id));
    purged++;
  }
  return purged;
}
