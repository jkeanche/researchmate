import { purgeStaleSessions } from "@researchmate/auth";
import { authTokens, closeDb, getDb } from "@researchmate/database";
import { env, type EmailJob, logger, QUEUES } from "@researchmate/shared";
import { expireReservations, getStorageDriver, LocalStorageDriver, purgeDeletedFiles } from "@researchmate/storage";
import { Queue, Worker } from "bullmq";
import { lt, or, isNotNull, and } from "drizzle-orm";
import nodemailer from "nodemailer";

/**
 * Background worker.
 *
 *  email        — delivers transactional email (SMTP) with retries.
 *  maintenance  — scheduled housekeeping: expire upload reservations, purge
 *                 deleted files after retention, clean temporary uploads,
 *                 delete stale sessions and spent tokens.
 *
 * Schedules are registered with BullMQ job schedulers, which are idempotent,
 * so running several worker replicas does not duplicate them.
 */

const e = env();
const connection = { url: e.REDIS_URL, maxRetriesPerRequest: null };
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

const emailWorker = new Worker<EmailJob>(QUEUES.email, async (job) => deliver(job.data), { connection, concurrency: e.WORKER_CONCURRENCY });

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

type MaintenanceTask = "expire-reservations" | "purge-deleted-files" | "clean-temporary" | "purge-auth";

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
const maintenanceWorker = new Worker(QUEUES.maintenance, async (job) => runMaintenance(job.name as MaintenanceTask), { connection, concurrency: 1 });

const SCHEDULES: [MaintenanceTask, string][] = [
  ["expire-reservations", "*/5 * * * *"],
  ["clean-temporary", "17 * * * *"],
  ["purge-deleted-files", "43 * * * *"],
  ["purge-auth", "11 3 * * *"],
];

for (const w of [emailWorker, maintenanceWorker]) {
  w.on("failed", (job, err) => logger.error("job.failed", { queue: w.name, job: job?.name, attempts: job?.attemptsMade, error: err.message }));
}

async function main() {
  await getStorageDriver(); // fail fast on storage misconfiguration
  for (const [name, pattern] of SCHEDULES) {
    await maintenanceQueue.upsertJobScheduler(name, { pattern }, { name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
  logger.info("worker.started", { queues: [QUEUES.email, QUEUES.maintenance], smtp: Boolean(transport) });
}

async function shutdown(signal: string) {
  logger.info("worker.stopping", { signal });
  await Promise.allSettled([emailWorker.close(), maintenanceWorker.close(), maintenanceQueue.close()]);
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  logger.error("worker.start_failed", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
