/** Background job queue names shared by the web app and the worker. */
export const QUEUES = {
  email: "email",
  maintenance: "maintenance",
  ai: "ai",
  drive: "drive",
  files: "files",
  documents: "documents",
  integrations: "integrations",
} as const;

export interface AiJob {
  runId: string;
}

export interface DriveJob {
  jobId: string;
  kind: "import" | "export";
}

/** Text extraction (and OCR) for an uploaded file version. */
export interface FileJob {
  jobId: string;
}

/** DOCX/PDF generation and validation for one export. */
export interface DocumentJob {
  exportId: string;
}

/** Apify Actor runs. */
export interface IntegrationJob {
  apifyRunId: string;
}

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Redis key the worker refreshes every 30 s (JSON: { at, pid, startedAt }); expires after 2 minutes. */
export const WORKER_HEARTBEAT_KEY = "rm:worker:heartbeat";
