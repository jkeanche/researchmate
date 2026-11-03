import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { connectedAccounts, type Database, driveJobs, externalFileReferences, files } from "@researchmate/database";
import { checkIntegrationAccess } from "@researchmate/entitlements";
import { AppError, decryptSecret, encryptSecret, logger } from "@researchmate/shared";
import type { FileService } from "@researchmate/storage";
import { getOrgAccess, getProjectAccess, notify, recordAudit } from "@researchmate/tenancy";
import { and, desc, eq, isNull } from "drizzle-orm";

/**
 * Google Drive integration (OAuth 2.0 with PKCE, offline access).
 *
 * Scope defaults to drive.file: the app sees only files it created or that
 * the user opened with it. drive.readonly allows browsing everything but is
 * a restricted scope that needs Google verification. Endpoints are
 * configurable so the integration can be tested against a local fake.
 */
export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: "drive.file" | "drive.readonly";
  maxImportBytes: number;
  endpoints?: Partial<typeof GOOGLE>;
}

const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

/** Google-native formats are exported to Office formats on import. */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
};

const AAD = (userId: string) => `google-drive:${userId}`;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export class DriveService {
  private readonly ep: typeof GOOGLE;

  constructor(
    private readonly db: Database,
    private readonly files: FileService,
    private readonly cfg: DriveConfig,
    private readonly enqueue: (jobId: string, kind: "import" | "export") => Promise<void> = async () => {},
  ) {
    this.ep = { ...GOOGLE, ...cfg.endpoints };
  }

  static configured(cfg: Partial<DriveConfig>): cfg is DriveConfig {
    return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
  }

  // ----- OAuth -------------------------------------------------------------

  /** Returns the consent URL plus the state and PKCE verifier the caller must keep server-side (httpOnly cookie). */
  async startAuth(actorUserId: string, organizationId: string) {
    await getOrgAccess(this.db, actorUserId, organizationId);
    await checkIntegrationAccess(this.db, organizationId, "google_drive");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(this.ep.auth);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: `https://www.googleapis.com/auth/${this.cfg.scope} https://www.googleapis.com/auth/userinfo.email`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, verifier };
  }

  async completeAuth(actorUserId: string, organizationId: string, code: string, verifier: string) {
    await getOrgAccess(this.db, actorUserId, organizationId);
    await checkIntegrationAccess(this.db, organizationId, "google_drive");
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.cfg.redirectUri });
    if (!tok.refresh_token) throw new AppError("VALIDATION", "Google didn't grant offline access. Remove ResearchMate from your Google account's third-party access and connect again.");
    const about = await this.fetchJson(`${this.ep.api}/about?fields=user(emailAddress)`, tok.access_token);
    const email = String((about.user as { emailAddress?: string } | undefined)?.emailAddress ?? "");
    const row = await this.db.transaction(async (tx) => {
      await tx.update(connectedAccounts).set({ revokedAt: new Date(), status: "revoked", encryptedRefreshToken: "revoked", encryptedAccessToken: null }).where(and(eq(connectedAccounts.userId, actorUserId), eq(connectedAccounts.organizationId, organizationId), eq(connectedAccounts.provider, "google_drive"), isNull(connectedAccounts.revokedAt)));
      const [r] = await tx
        .insert(connectedAccounts)
        .values({
          userId: actorUserId,
          organizationId,
          provider: "google_drive",
          accountEmail: email,
          scopes: String(tok.scope ?? this.cfg.scope),
          encryptedRefreshToken: encryptSecret(tok.refresh_token!, AAD(actorUserId)),
          encryptedAccessToken: encryptSecret(tok.access_token, AAD(actorUserId)),
          accessTokenExpiresAt: new Date(Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000),
        })
        .returning({ id: connectedAccounts.id, accountEmail: connectedAccounts.accountEmail });
      return r!;
    });
    await recordAudit(this.db, { organizationId, actorUserId, action: "drive.connected", targetType: "connected_account", targetId: row.id, metadata: { email } });
    return row;
  }

  /** Public view of the connection (never includes tokens). */
  async connection(actorUserId: string, organizationId: string) {
    const [a] = await this.db
      .select({ id: connectedAccounts.id, accountEmail: connectedAccounts.accountEmail, status: connectedAccounts.status, scopes: connectedAccounts.scopes, connectedAt: connectedAccounts.connectedAt, lastError: connectedAccounts.lastError })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, actorUserId), eq(connectedAccounts.organizationId, organizationId), eq(connectedAccounts.provider, "google_drive"), isNull(connectedAccounts.revokedAt)));
    return a ?? null;
  }

  async disconnect(actorUserId: string, organizationId: string) {
    const [a] = await this.db.select().from(connectedAccounts).where(and(eq(connectedAccounts.userId, actorUserId), eq(connectedAccounts.organizationId, organizationId), eq(connectedAccounts.provider, "google_drive"), isNull(connectedAccounts.revokedAt)));
    if (!a) return;
    try {
      await fetch(this.ep.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: decryptSecret(a.encryptedRefreshToken, AAD(actorUserId)) }) });
    } catch (err) {
      logger.warn("drive.revoke_failed", { error: String(err) }); // the local record is removed regardless
    }
    await this.db.update(connectedAccounts).set({ revokedAt: new Date(), status: "revoked", encryptedRefreshToken: "revoked", encryptedAccessToken: null }).where(eq(connectedAccounts.id, a.id));
    await recordAudit(this.db, { organizationId, actorUserId, action: "drive.disconnected", targetType: "connected_account", targetId: a.id });
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await fetch(this.ep.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!res.ok) {
      const err = new AppError(body.error === "invalid_grant" ? "UNAUTHENTICATED" : "VALIDATION", body.error === "invalid_grant" ? "Google access has expired or was revoked. Reconnect Google Drive." : "Google rejected the sign-in. Try connecting again.", { google: body.error });
      throw err;
    }
    return body;
  }

  private async account(actorUserId: string, organizationId: string) {
    await getOrgAccess(this.db, actorUserId, organizationId);
    await checkIntegrationAccess(this.db, organizationId, "google_drive");
    const [a] = await this.db.select().from(connectedAccounts).where(and(eq(connectedAccounts.userId, actorUserId), eq(connectedAccounts.organizationId, organizationId), eq(connectedAccounts.provider, "google_drive"), isNull(connectedAccounts.revokedAt)));
    if (!a) throw new AppError("VALIDATION", "Connect Google Drive first.");
    if (a.status === "reauth_required") throw new AppError("UNAUTHENTICATED", "Google access has expired. Reconnect Google Drive.");
    return a;
  }

  /** A valid access token, refreshing it when expired. A revoked grant marks the account for reconnection. */
  private async accessToken(a: typeof connectedAccounts.$inferSelect): Promise<string> {
    if (a.encryptedAccessToken && a.accessTokenExpiresAt && a.accessTokenExpiresAt.getTime() > Date.now()) return decryptSecret(a.encryptedAccessToken, AAD(a.userId));
    try {
      const tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: decryptSecret(a.encryptedRefreshToken, AAD(a.userId)) });
      await this.db
        .update(connectedAccounts)
        .set({ encryptedAccessToken: encryptSecret(tok.access_token, AAD(a.userId)), accessTokenExpiresAt: new Date(Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000), lastError: null })
        .where(eq(connectedAccounts.id, a.id));
      return tok.access_token;
    } catch (err) {
      if ((err as AppError).code === "UNAUTHENTICATED") {
        await this.db.update(connectedAccounts).set({ status: "reauth_required", lastError: (err as Error).message }).where(eq(connectedAccounts.id, a.id));
        await notify(this.db, { userIds: [a.userId], kind: "drive.reauth", title: "Reconnect Google Drive", body: "Google no longer accepts ResearchMate's access to your Drive (it was revoked or expired). Imports and exports will fail until you reconnect it.", link: "/app/settings/integrations", organizationId: a.organizationId, dedupeKey: `drive.reauth:${a.id}:${new Date().toISOString().slice(0, 10)}` });
      }
      throw err;
    }
  }

  private async fetchJson(url: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (res.status === 404) throw new AppError("NOT_FOUND", "That Drive file isn't available to ResearchMate (with limited access, only files created or opened with ResearchMate are visible).");
    if (!res.ok) throw new AppError("VALIDATION", `Google Drive returned an error (${res.status}).`);
    return (await res.json()) as Record<string, unknown>;
  }

  // ----- Browse ------------------------------------------------------------

  async listFiles(actorUserId: string, organizationId: string, opts: { search?: string; pageToken?: string } = {}) {
    const a = await this.account(actorUserId, organizationId);
    const token = await this.accessToken(a);
    const q = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
    if (opts.search?.trim()) q.push(`name contains '${opts.search.trim().replace(/\\/g, "\\\\").replace(/'/g, "\\'").slice(0, 100)}'`);
    const url = new URL(`${this.ep.api}/files`);
    url.search = new URLSearchParams({ q: q.join(" and "), pageSize: "50", orderBy: "modifiedTime desc", fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink)", ...(opts.pageToken ? { pageToken: opts.pageToken } : {}) }).toString();
    const body = await this.fetchJson(url.toString(), token);
    const list = (body.files as DriveFile[] | undefined) ?? [];
    const imported = list.length
      ? await this.db.select({ externalId: externalFileReferences.externalId, importedFileId: externalFileReferences.importedFileId }).from(externalFileReferences).where(and(eq(externalFileReferences.organizationId, organizationId), eq(externalFileReferences.provider, "google_drive")))
      : [];
    const importedIds = new Set(imported.filter((i) => i.importedFileId).map((i) => i.externalId));
    return { files: list.map((f) => ({ ...f, imported: importedIds.has(f.id) })), nextPageToken: (body.nextPageToken as string | undefined) ?? null, scope: this.cfg.scope };
  }

  // ----- Jobs --------------------------------------------------------------

  async requestImport(actorUserId: string, organizationId: string, externalId: string, projectId: string | null) {
    const a = await this.account(actorUserId, organizationId);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(externalId)) throw new AppError("VALIDATION", "Invalid Drive file.");
    if (projectId) {
      const access = await getProjectAccess(this.db, actorUserId, projectId);
      if (access.organizationId !== organizationId || !access.permissions.has("project.files.write")) throw new AppError("FORBIDDEN", "You can't add files to that project.");
    }
    const [job] = await this.db.insert(driveJobs).values({ kind: "import", organizationId, projectId, userId: actorUserId, connectedAccountId: a.id, params: { externalId } }).returning();
    await this.enqueue(job!.id, "import");
    return job!;
  }

  async requestExport(actorUserId: string, organizationId: string, fileId: string, folderId?: string | null) {
    const a = await this.account(actorUserId, organizationId);
    await this.files.requireFileAccess(actorUserId, fileId, "read");
    if (folderId && !/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) throw new AppError("VALIDATION", "Invalid Drive folder.");
    const [job] = await this.db.insert(driveJobs).values({ kind: "export", organizationId, userId: actorUserId, connectedAccountId: a.id, params: { fileId, folderId: folderId ?? null } }).returning();
    await this.enqueue(job!.id, "export");
    return job!;
  }

  async listJobs(actorUserId: string, organizationId: string) {
    return this.db.select().from(driveJobs).where(and(eq(driveJobs.userId, actorUserId), eq(driveJobs.organizationId, organizationId))).orderBy(desc(driveJobs.createdAt)).limit(20);
  }

  /** Runs one job (worker). Errors are stored on the job. */
  async processJob(jobId: string) {
    const [job] = await this.db.select().from(driveJobs).where(eq(driveJobs.id, jobId));
    if (!job || job.status === "succeeded") return;
    await this.db.update(driveJobs).set({ status: "running" }).where(eq(driveJobs.id, jobId));
    try {
      const result = job.kind === "import" ? await this.runImport(job) : await this.runExport(job);
      await this.db.update(driveJobs).set({ status: "succeeded", result, error: null, finishedAt: new Date() }).where(eq(driveJobs.id, jobId));
    } catch (err) {
      const message = err instanceof AppError || (err as { name?: string })?.name === "AppError" ? (err as Error).message : "The Drive transfer failed.";
      if (!(err instanceof AppError)) logger.error("drive.job_failed", { jobId, error: err instanceof Error ? err.stack : String(err) });
      await this.db.update(driveJobs).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(driveJobs.id, jobId));
    }
  }

  private async runImport(job: typeof driveJobs.$inferSelect) {
    const userId = job.userId!;
    const a = await this.account(userId, job.organizationId);
    const token = await this.accessToken(a);
    const externalId = String(job.params.externalId);
    const meta = (await this.fetchJson(`${this.ep.api}/files/${encodeURIComponent(externalId)}?fields=id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink`, token)) as unknown as DriveFile;
    const exp = EXPORTS[meta.mimeType];
    if (meta.mimeType.startsWith("application/vnd.google-apps.") && !exp) throw new AppError("VALIDATION", "That kind of Google file can't be imported.");

    const [existing] = await this.db.select().from(externalFileReferences).where(and(eq(externalFileReferences.organizationId, job.organizationId), eq(externalFileReferences.provider, "google_drive"), eq(externalFileReferences.externalId, externalId)));
    const [existingFile] = existing?.importedFileId ? await this.db.select().from(files).where(and(eq(files.id, existing.importedFileId), isNull(files.deletedAt))) : [];
    const unchanged = existingFile && ((meta.md5Checksum && meta.md5Checksum === existing!.importedVersionMd5) || (!meta.md5Checksum && meta.modifiedTime && existing!.importedModifiedAt && new Date(meta.modifiedTime).getTime() === existing!.importedModifiedAt.getTime()));
    if (unchanged) return { fileId: existingFile!.id, duplicate: true };

    // Download (or export) with a hard size cap. Google exports have no announced size, so they are buffered up to the cap.
    const url = exp ? `${this.ep.api}/files/${encodeURIComponent(externalId)}/export?mimeType=${encodeURIComponent(exp.mime)}` : `${this.ep.api}/files/${encodeURIComponent(externalId)}?alt=media`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok || !res.body) throw new AppError("VALIDATION", `Google Drive refused the download (${res.status}).`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > this.cfg.maxImportBytes) throw new AppError("QUOTA_EXCEEDED", `The file is larger than the ${Math.round(this.cfg.maxImportBytes / 1048576)} MB import limit.`);
      chunks.push(Buffer.from(c));
    }
    const buf = Buffer.concat(chunks);
    const filename = exp && !meta.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${meta.name}.${exp.ext}` : meta.name;
    const stored = existingFile
      ? await this.files.uploadNewVersion({ actorUserId: userId, fileId: existingFile.id, filename, declaredSize: buf.length, body: Readable.from([buf]) })
      : await this.files.upload({ actorUserId: userId, organizationId: job.organizationId, projectId: job.projectId, filename, declaredSize: buf.length, body: Readable.from([buf]) });
    const fileId = (stored as { id: string }).id ?? existingFile!.id;
    const values = {
      organizationId: job.organizationId,
      projectId: job.projectId,
      connectedAccountId: a.id,
      provider: "google_drive",
      externalId,
      name: meta.name,
      mimeType: meta.mimeType,
      sizeBytes: meta.size ? Number(meta.size) : buf.length,
      md5: meta.md5Checksum ?? null,
      externalModifiedAt: meta.modifiedTime ? new Date(meta.modifiedTime) : null,
      webViewLink: meta.webViewLink ?? null,
      importedFileId: fileId,
      importedVersionMd5: meta.md5Checksum ?? null,
      importedModifiedAt: meta.modifiedTime ? new Date(meta.modifiedTime) : null,
      updatedAt: new Date(),
    };
    await this.db.insert(externalFileReferences).values(values).onConflictDoUpdate({ target: [externalFileReferences.organizationId, externalFileReferences.provider, externalFileReferences.externalId], set: values });
    await recordAudit(this.db, { organizationId: job.organizationId, actorUserId: userId, action: existingFile ? "drive.import.new_version" : "drive.import", targetType: "file", targetId: fileId, metadata: { externalId } });
    return { fileId, duplicate: false, newVersion: Boolean(existingFile) };
  }

  private async runExport(job: typeof driveJobs.$inferSelect) {
    const userId = job.userId!;
    const a = await this.account(userId, job.organizationId);
    const token = await this.accessToken(a);
    const dl = await this.files.openForDownload(userId, String(job.params.fileId));
    const chunks: Buffer[] = [];
    for await (const c of dl.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const boundary = `rm${randomBytes(12).toString("hex")}`;
    const metadata = { name: dl.file.originalName, ...(job.params.folderId ? { parents: [String(job.params.folderId)] } : {}) };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${dl.file.mimeType}\r\n\r\n`),
      Buffer.concat(chunks),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const created = (await this.fetchJson(`${this.ep.upload}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,md5Checksum,modifiedTime`, token, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body })) as unknown as DriveFile;
    await this.db
      .insert(externalFileReferences)
      .values({ organizationId: job.organizationId, connectedAccountId: a.id, provider: "google_drive", externalId: created.id, name: created.name, mimeType: created.mimeType, md5: created.md5Checksum ?? null, webViewLink: created.webViewLink ?? null, externalModifiedAt: created.modifiedTime ? new Date(created.modifiedTime) : null })
      .onConflictDoNothing();
    await recordAudit(this.db, { organizationId: job.organizationId, actorUserId: userId, action: "drive.export", targetType: "file", targetId: String(job.params.fileId), metadata: { externalId: created.id } });
    return { externalId: created.id, webViewLink: created.webViewLink ?? null };
  }
}
