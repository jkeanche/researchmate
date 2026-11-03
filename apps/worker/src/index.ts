import { writeFile } from "node:fs/promises";
import { getRedis, purgeStaleSessions } from "@researchmate/auth";
import { authTokens, closeDb, getDb } from "@researchmate/database";
import { deliverNotificationEmails, scanDeadlines } from "@researchmate/tenancy";
import { AiService } from "@researchmate/ai";
import { PaymentService, providersFromEnv } from "@researchmate/billing";
import { DocumentService } from "@researchmate/documents";
import { ApifyService, DriveService } from "@researchmate/integrations";
import { LiteratureService, ScholarlyClient } from "@researchmate/literature";
import { type AiJob, type DocumentJob, type DriveJob, env, type EmailJob, type FileJob, type IntegrationJob, logger, platformModelFromEnv, QUEUES, WORKER_HEARTBEAT_KEY } from "@researchmate/shared";
import { ClamAvScanner, expireReservations, FileService, getStorageDriver, LocalStorageDriver, purgeDeletedFiles, purgeDeletedOrganizations } from "@researchmate/storage";
import { Queue, Worker } from "bullmq";
import { lt, or, isNotNull, and } from "drizzle-orm";
import nodemailer from "nodemailer";

/**
 * Background worker.
 *
 *  email        — delivers transactional email (SMTP) with retries.
 *  maintenance  — scheduled housekeeping: expire upload reservations, purge
 *                 deleted files after retention, clean temporary uploads,
 *                 delete stale sessions and spent tokens, billing renewals,
 *                 deadline notices (hourly) and notification email (every minute).
 *
 * Schedules are registered with BullMQ job schedulers, which are idempotent,
 * so running several worker replicas does not duplicate them.
 */

const e = env();
const connection = { url: e.REDIS_URL, maxRetriesPerRequest: null };
/**
 * WORKER_ROLE: "all" (default) processes jobs and registers schedules; "jobs"
 * only processes jobs (scale these out); "scheduler" only registers the
 * maintenance schedules (run exactly one; BullMQ schedulers are idempotent anyway).
 */
const ROLE = (process.env.WORKER_ROLE ?? "all") as "all" | "jobs" | "scheduler";
if (!["all", "jobs", "scheduler"].includes(ROLE)) throw new Error(`WORKER_ROLE must be all, jobs or scheduler (got ${ROLE})`);
const RUN_JOBS = ROLE !== "scheduler";
const FILE_RETENTION_HOURS = Number(process.env.FILE_RETENTION_HOURS ?? 72);

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const transport = e.EMAIL_HOST
  ? nodemailer.createTransport({
      host: e.EMAIL_HOST,
      port: e.EMAIL_PORT ?? 587,
      secure: (e.EMAIL_PORT ?? 587) === 465,
      auth: e.EMAIL_USERNAME ? { user: e.EMAIL_USERNAME, pass: e.EMAIL_PASSWORD } : undefined,
    })
  : null;

async function deliver(job: EmailJob) {
  if (transport) {
    await transport.sendMail({ from: e.EMAIL_FROM, to: job.to, subject: job.subject, text: job.text, html: job.html });
    logger.info("email.sent", { subject: job.subject });
    return;
  }
  // Development only (production requires EMAIL_HOST): print the message so links can be followed.
  console.log(`\n──── email (no SMTP configured) ────\nTo: ${job.to}\nSubject: ${job.subject}\n\n${job.text}\n────────────────────────────────────\n`);
}

const emailWorker = new Worker<EmailJob>(QUEUES.email, async (job) => deliver(job.data), { connection, autorun: RUN_JOBS, concurrency: e.WORKER_CONCURRENCY });

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

type MaintenanceTask = "expire-reservations" | "purge-deleted-files" | "clean-temporary" | "purge-auth" | "billing-renewals" | "deadline-scan" | "notification-emails" | "purge-organizations";

async function runMaintenance(name: MaintenanceTask) {
  const db = getDb();
  switch (name) {
    case "expire-reservations": {
      const n = await expireReservations(db);
      if (n) logger.info("maintenance.reservations_expired", { count: n });
      return { expired: n };
    }
    case "purge-deleted-files": {
      const n = await purgeDeletedFiles(db, await getStorageDriver(), FILE_RETENTION_HOURS);
      if (n) logger.info("maintenance.files_purged", { count: n });
      return { purged: n };
    }
    case "clean-temporary": {
      const driver = await getStorageDriver();
      const n = driver instanceof LocalStorageDriver ? await driver.cleanTemporary(6 * 3600 * 1000) : 0;
      return { removed: n };
    }
    case "billing-renewals": {
      // Renewal reminders, past-due and expiry, and re-checking abandoned checkouts.
      const svc = new PaymentService(db, { providers: providersFromEnv(e as unknown as Record<string, string | undefined>), appUrl: e.APP_URL, graceDays: e.BILLING_GRACE_DAYS });
      return svc.runRenewals();
    }
    case "purge-organizations": {
      const r = await purgeDeletedOrganizations(db, await getStorageDriver());
      if (r.organizations) logger.info("maintenance.organizations_purged", r);
      return r;
    }
    case "deadline-scan":
      return scanDeadlines(db);
    case "notification-emails":
      // Queued, not sent inline, so SMTP retries/backoff apply.
      return deliverNotificationEmails(db, async (m) => void (await emailQueue.add("send", m, { attempts: 5, backoff: { type: "exponential", delay: 30_000 } })), e.APP_URL);
    case "purge-auth": {
      const sessions = await purgeStaleSessions(db);
      const cutoff = new Date(Date.now() - 7 * 86400000);
      const tokens = await db
        .delete(authTokens)
        .where(or(lt(authTokens.expiresAt, cutoff), and(isNotNull(authTokens.consumedAt), lt(authTokens.consumedAt, cutoff))))
        .returning({ id: authTokens.id });
      return { sessions, tokens: tokens.length };
    }
  }
}

const maintenanceQueue = new Queue(QUEUES.maintenance, { connection });
const emailQueue = new Queue<EmailJob>(QUEUES.email, { connection });
const maintenanceWorker = new Worker(QUEUES.maintenance, async (job) => runMaintenance(job.name as MaintenanceTask), { connection, autorun: RUN_JOBS, concurrency: 1 });

const SCHEDULES: [MaintenanceTask, string][] = [
  ["expire-reservations", "*/5 * * * *"],
  ["clean-temporary", "17 * * * *"],
  ["purge-deleted-files", "43 * * * *"],
  ["purge-auth", "11 3 * * *"],
  ["billing-renewals", "23 * * * *"],
  ["deadline-scan", "7 * * * *"],
  ["notification-emails", "* * * * *"],
  ["purge-organizations", "37 2 * * *"],
];

// ---------------------------------------------------------------------------
// AI runs and Google Drive transfers
// ---------------------------------------------------------------------------

const ai = new AiService(getDb(), { enqueue: async () => {}, allowPrivateEndpoints: e.ALLOW_PRIVATE_ENDPOINTS, platform: platformModelFromEnv(e), platformMaxOutputTokens: e.PLATFORM_AI_MAX_OUTPUT_TOKENS });
// One attempt per run: transient provider errors are retried inside the AI call itself.
const aiWorker = new Worker<AiJob>(QUEUES.ai, async (job) => ai.processRun(job.data.runId), { connection, autorun: RUN_JOBS, concurrency: e.WORKER_CONCURRENCY });

// Text extraction / OCR. Extraction failures are recorded on the job row (not retried by the queue).
const filesQueue = new Queue<FileJob>(QUEUES.files, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } });
let lit: LiteratureService | null = null;
async function literature() {
  lit ??= new LiteratureService(getDb(), { scholarly: new ScholarlyClient({ contactEmail: e.SCHOLARLY_CONTACT_EMAIL }), driver: await getStorageDriver(), ocr: e.OCR_ENABLED, enqueueExtraction: async (jobId) => void (await filesQueue.add("extract", { jobId }, { jobId })) });
  return lit;
}
let drive: DriveService | null = null;
async function driveService() {
  if (!drive) {
    const lit = await literature();
    const files = new FileService({ db: getDb(), driver: await getStorageDriver(), maxUploadBytes: e.MAX_UPLOAD_SIZE_MB * 1024 * 1024, scanner: e.CLAMAV_HOST ? new ClamAvScanner({ host: e.CLAMAV_HOST, port: e.CLAMAV_PORT }) : undefined, afterStore: (f) => lit.queueExtraction(f.id, f.version, f.mimeType, f.aiProcessingAllowed) });
    drive = new DriveService(getDb(), files, { clientId: e.GOOGLE_CLIENT_ID ?? "", clientSecret: e.GOOGLE_CLIENT_SECRET ?? "", redirectUri: e.GOOGLE_REDIRECT_URI ?? "", scope: e.GOOGLE_DRIVE_SCOPE, maxImportBytes: e.MAX_UPLOAD_SIZE_MB * 1024 * 1024 });
  }
  return drive;
}
const driveWorker = new Worker<DriveJob>(QUEUES.drive, async (job) => (await driveService()).processJob(job.data.jobId), { connection, autorun: RUN_JOBS, concurrency: 2 });

const filesWorker = new Worker<FileJob>(QUEUES.files, async (job) => (await literature()).processExtraction(job.data.jobId), { connection, autorun: RUN_JOBS, concurrency: 2 });

// DOCX/PDF generation. LibreOffice runs per job in its own profile; concurrency is kept low (memory).
let docs: DocumentService | null = null;
const documentsWorker = new Worker<DocumentJob>(
  QUEUES.documents,
  async (job) => {
    docs ??= new DocumentService(getDb(), { driver: await getStorageDriver() });
    return docs.processExport(job.data.exportId);
  },
  { connection, autorun: RUN_JOBS, concurrency: Number(process.env.DOCUMENT_CONCURRENCY ?? 2) },
);

// Apify Actor runs (polled until finished, bounded by each Actor's timeout).
const apify = new ApifyService(getDb(), { platformToken: e.APIFY_TOKEN ?? null, allowPrivateEndpoints: e.ALLOW_PRIVATE_ENDPOINTS });
const integrationsWorker = new Worker<IntegrationJob>(QUEUES.integrations, async (job) => apify.process(job.data.apifyRunId), { connection, autorun: RUN_JOBS, concurrency: 4 });

for (const w of [emailWorker, maintenanceWorker, aiWorker, driveWorker, filesWorker, documentsWorker, integrationsWorker]) {
  w.on("failed", (job, err) => logger.error("job.failed", { queue: w.name, job: job?.name, attempts: job?.attemptsMade, error: err.message }));
}

// Heartbeat for /api/health and /api/metrics: lets monitoring notice a stopped worker.
const startedAt = new Date().toISOString();
const HEARTBEAT = RUN_JOBS ? WORKER_HEARTBEAT_KEY : `${WORKER_HEARTBEAT_KEY}:scheduler`;
// The file lets Docker's HEALTHCHECK see liveness without network access (see worker.Dockerfile).
// Independent: a failing file write never stops the Redis heartbeat (and vice versa).
const beat = () =>
  Promise.allSettled([
    getRedis().set(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, startedAt, role: ROLE }), "EX", 120),
    writeFile(process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/researchmate-heartbeat", new Date().toISOString()),
  ]).then((rs) => {
    for (const r of rs) if (r.status === "rejected") logger.warn("worker.heartbeat_failed", { error: String(r.reason) });
  });
const heartbeat = setInterval(beat, 30_000);

async function main() {
  await beat();
  await getStorageDriver(); // fail fast on storage misconfiguration
  if (ROLE !== "jobs") {
    for (const [name, pattern] of SCHEDULES) {
      await maintenanceQueue.upsertJobScheduler(name, { pattern }, { name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
    }
  }
  logger.info("worker.started", { role: ROLE, queues: Object.values(QUEUES), smtp: Boolean(transport), googleDrive: Boolean(e.GOOGLE_CLIENT_ID) });
}

async function shutdown(signal: string) {
  logger.info("worker.stopping", { signal });
  // The heartbeat key is shared by all worker instances, so it isn't deleted here: another
  // instance may still be running (or a replacement already started). It expires after 2 minutes.
  clearInterval(heartbeat);
  await Promise.allSettled([emailWorker.close(), maintenanceWorker.close(), aiWorker.close(), driveWorker.close(), filesWorker.close(), documentsWorker.close(), integrationsWorker.close(), filesQueue.close(), maintenanceQueue.close(), emailQueue.close()]);
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  logger.error("worker.start_failed", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
