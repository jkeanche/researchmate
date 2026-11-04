import { AdminService, PlanAdminService, SupportService } from "@researchmate/admin";
import { ToolkitService } from "@researchmate/toolkit";
import { AuthService, getRedis, type EmailMessage, type Mailer, RedisRateLimiter } from "@researchmate/auth";
import { getDb } from "@researchmate/database";
import { AiService } from "@researchmate/ai";
import { FinanceService } from "@researchmate/finance";
import { PaymentService, providersFromEnv } from "@researchmate/billing";
import { CollaborationService } from "@researchmate/collaboration";
import { DocumentService } from "@researchmate/documents";
import { ApifyService, DriveService, McpService, WebCaptureService } from "@researchmate/integrations";
import { LiteratureService, ScholarlyClient } from "@researchmate/literature";
import { PlanningService } from "@researchmate/planning";
import { ProjectMemberService, ProjectService, ResearchContentService, WorkflowService } from "@researchmate/research";
import { type AiJob, type DocumentJob, type DriveJob, env, type EmailJob, type FileJob, type IntegrationJob, platformModelFromEnv, QUEUES } from "@researchmate/shared";
import { ClamAvScanner, FileService, getStorageDriver } from "@researchmate/storage";
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
  __rmPlanning?: PlanningService;
  __rmWorkflow?: WorkflowService;
  __rmContent?: ResearchContentService;
  __rmMembers?: ProjectMemberService;
  __rmFinance?: FinanceService;
  __rmAi?: AiService;
  __rmAiQueue?: Queue<AiJob>;
  __rmDrive?: DriveService;
  __rmDriveQueue?: Queue<DriveJob>;
  __rmLit?: LiteratureService;
  __rmDocs?: DocumentService;
  __rmCollab?: CollaborationService;
  __rmPay?: PaymentService;
  __rmMcp?: McpService;
  __rmApify?: ApifyService;
  __rmIntQueue?: Queue<IntegrationJob>;
  __rmToolkit?: ToolkitService;
  __rmWeb?: WebCaptureService;
  __rmDocsQueue?: Queue<DocumentJob>;
  __rmFilesQueue?: Queue<FileJob>;
  __rmAdmin?: AdminService;
  __rmPlanAdmin?: PlanAdminService;
  __rmSupport?: SupportService;
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
    // After every stored version, queue text extraction (skipped when AI processing is off for the file).
    g.__rmFiles = new FileService({ db: db(), driver, maxUploadBytes: env().MAX_UPLOAD_SIZE_MB * 1024 * 1024, scanner: env().CLAMAV_HOST ? new ClamAvScanner({ host: env().CLAMAV_HOST!, port: env().CLAMAV_PORT }) : undefined, afterStore: (f) => literatureService().queueExtraction(f.id, f.version, f.mimeType, f.aiProcessingAllowed) });
  }
  return g.__rmFiles;
}

export function projectService(): ProjectService {
  g.__rmProjects ??= new ProjectService(db());
  return g.__rmProjects;
}

export function planningService(): PlanningService {
  g.__rmPlanning ??= new PlanningService(db());
  return g.__rmPlanning;
}

export function workflowService(): WorkflowService {
  g.__rmWorkflow ??= new WorkflowService(db());
  return g.__rmWorkflow;
}

export function contentService(): ResearchContentService {
  g.__rmContent ??= new ResearchContentService(db());
  return g.__rmContent;
}

export function memberService(): ProjectMemberService {
  g.__rmMembers ??= new ProjectMemberService(db());
  return g.__rmMembers;
}

export function financeService(): FinanceService {
  g.__rmFinance ??= new FinanceService(db());
  return g.__rmFinance;
}

export function literatureService(): LiteratureService {
  if (!g.__rmLit) {
    const e = env();
    g.__rmFilesQueue ??= queue<FileJob>(QUEUES.files);
    g.__rmLit = new LiteratureService(db(), {
      scholarly: new ScholarlyClient({ contactEmail: e.SCHOLARLY_CONTACT_EMAIL, semanticScholarKey: e.SEMANTIC_SCHOLAR_API_KEY, minIntervalMs: 1100 }),
      enqueueExtraction: async (jobId) => void (await g.__rmFilesQueue!.add("extract", { jobId }, { jobId })),
    });
  }
  return g.__rmLit;
}

export async function documentService(): Promise<DocumentService> {
  if (!g.__rmDocs) {
    g.__rmDocsQueue ??= queue<DocumentJob>(QUEUES.documents);
    g.__rmDocs = new DocumentService(db(), { driver: await getStorageDriver(), enqueueExport: async (exportId) => void (await g.__rmDocsQueue!.add("export", { exportId }, { jobId: exportId })) });
  }
  return g.__rmDocs;
}

export async function collaborationService(): Promise<CollaborationService> {
  g.__rmCollab ??= new CollaborationService(db(), { documents: await documentService(), appUrl: env().APP_URL, notify: (to, subject, text) => new QueueMailer().send({ to, subject, text }) });
  return g.__rmCollab;
}

export function paymentService(): PaymentService {
  const e = env();
  g.__rmPay ??= new PaymentService(db(), { providers: providersFromEnv(e as unknown as Record<string, string | undefined>), appUrl: e.APP_URL, graceDays: e.BILLING_GRACE_DAYS });
  return g.__rmPay;
}

export function mcpService(): McpService {
  g.__rmMcp ??= new McpService(db(), { allowPrivateEndpoints: env().ALLOW_PRIVATE_ENDPOINTS });
  return g.__rmMcp;
}

export function apifyService(): ApifyService {
  g.__rmIntQueue ??= queue<IntegrationJob>(QUEUES.integrations);
  g.__rmApify ??= new ApifyService(db(), { platformToken: env().APIFY_TOKEN ?? null, allowPrivateEndpoints: env().ALLOW_PRIVATE_ENDPOINTS, enqueue: async (id) => void (await g.__rmIntQueue!.add("apify", { apifyRunId: id }, { jobId: id })) });
  return g.__rmApify;
}

export async function webCaptureService(): Promise<WebCaptureService> {
  g.__rmWeb ??= new WebCaptureService(db(), { files: await fileService(), library: literatureService() as never, platformDomains: (env().WEB_APPROVED_DOMAINS ?? "").split(","), allowPrivateEndpoints: env().ALLOW_PRIVATE_ENDPOINTS });
  return g.__rmWeb;
}

function queue<T>(name: string) {
  return new Queue<T>(name, { connection: { url: env().REDIS_URL, maxRetriesPerRequest: null }, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } });
}

export function aiService(): AiService {
  g.__rmAiQueue ??= queue<AiJob>(QUEUES.ai);
  g.__rmAi ??= new AiService(db(), { enqueue: async (runId) => void (await g.__rmAiQueue!.add("run", { runId }, { jobId: runId })), allowPrivateEndpoints: env().ALLOW_PRIVATE_ENDPOINTS, platform: platformModelFromEnv(env()), platformMaxOutputTokens: env().PLATFORM_AI_MAX_OUTPUT_TOKENS });
  return g.__rmAi;
}

export function driveConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REDIRECT_URI);
}

export async function driveService(): Promise<DriveService> {
  if (!g.__rmDrive) {
    const e = env();
    g.__rmDriveQueue ??= queue<DriveJob>(QUEUES.drive);
    g.__rmDrive = new DriveService(db(), await fileService(), { clientId: e.GOOGLE_CLIENT_ID ?? "", clientSecret: e.GOOGLE_CLIENT_SECRET ?? "", redirectUri: e.GOOGLE_REDIRECT_URI ?? "", scope: e.GOOGLE_DRIVE_SCOPE, maxImportBytes: e.MAX_UPLOAD_SIZE_MB * 1024 * 1024 }, async (jobId, kind) => void (await g.__rmDriveQueue!.add(kind, { jobId, kind }, { jobId })));
  }
  return g.__rmDrive;
}

export async function toolkitService(): Promise<ToolkitService> {
  g.__rmToolkit ??= new ToolkitService(db(), { driver: await getStorageDriver() });
  return g.__rmToolkit;
}

/** Platform administration. Every method re-checks the actor is an administrator. */
export function adminService(): AdminService {
  g.__rmAdmin ??= new AdminService(db());
  return g.__rmAdmin;
}

export function planAdminService(): PlanAdminService {
  g.__rmPlanAdmin ??= new PlanAdminService(db());
  return g.__rmPlanAdmin;
}

/** Enquiries: the contact form, Help, and the administrators' inbox. */
export function supportService(): SupportService {
  const e = env();
  g.__rmSupport ??= new SupportService({ db: db(), mailer: new QueueMailer(), appUrl: e.APP_URL, secret: e.APP_SECRET });
  return g.__rmSupport;
}
