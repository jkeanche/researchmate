import { AuthService, getRedis, type EmailMessage, type Mailer, RedisRateLimiter } from "@researchmate/auth";
import { getDb } from "@researchmate/database";
import { ProjectService } from "@researchmate/research";
import { env, type EmailJob, QUEUES } from "@researchmate/shared";
import { FileService, getStorageDriver } from "@researchmate/storage";
import { Queue } from "bullmq";

/**
 * Process-wide service instances for the web app. Cached on globalThis so
 * development hot reloads don't create new pools and queues.
 */
const g = globalThis as unknown as {
  __rmEmailQueue?: Queue<EmailJob>;
  __rmAuth?: AuthService;
  __rmFiles?: FileService;
  __rmProjects?: ProjectService;
};

function emailQueue(): Queue<EmailJob> {
  g.__rmEmailQueue ??= new Queue<EmailJob>(QUEUES.email, {
    connection: { url: env().REDIS_URL, maxRetriesPerRequest: null },
    defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 15_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
  });
  return g.__rmEmailQueue;
}

/** Hands email to the worker, which delivers over SMTP with retries. */
class QueueMailer implements Mailer {
  async send(message: EmailMessage) {
    await emailQueue().add("send", message);
  }
}

export function db() {
  env(); // validate configuration on first use
  return getDb();
}

export function authService(): AuthService {
  const e = env();
  g.__rmAuth ??= new AuthService({
    db: db(),
    mailer: new QueueMailer(),
    limiter: new RedisRateLimiter(getRedis()),
    config: { appUrl: e.APP_URL, requireEmailVerification: e.REQUIRE_EMAIL_VERIFICATION, sessionTtlDays: e.SESSION_TTL_DAYS },
  });
  return g.__rmAuth;
}

export async function fileService(): Promise<FileService> {
  if (!g.__rmFiles) {
    const driver = await getStorageDriver();
    g.__rmFiles = new FileService({ db: db(), driver, maxUploadBytes: env().MAX_UPLOAD_SIZE_MB * 1024 * 1024 });
  }
  return g.__rmFiles;
}

export function projectService(): ProjectService {
  g.__rmProjects ??= new ProjectService(db());
  return g.__rmProjects;
}
