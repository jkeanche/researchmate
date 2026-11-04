import { getRedis } from "@researchmate/auth";
import { QUEUES, WORKER_HEARTBEAT_KEY } from "@researchmate/shared";
import { getStorageDriver } from "@researchmate/storage";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { db } from "./services";

const g = globalThis as unknown as { __rmMetricQueues?: Queue[] };
const queues = () => (g.__rmMetricQueues ??= Object.values(QUEUES).map((name) => new Queue(name, { connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null } })));

async function timed<T>(fn: () => Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/** Worker heartbeat age in seconds, or null when no live worker has reported in the last 2 minutes. */
export async function workerHeartbeatAge(): Promise<number | null> {
  const raw = await timed(() => getRedis().get(WORKER_HEARTBEAT_KEY)).catch(() => null);
  if (!raw) return null;
  try {
    return Math.max(0, (Date.now() - Date.parse((JSON.parse(raw) as { at: string }).at)) / 1000);
  } catch {
    return null;
  }
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Prometheus text exposition (version 0.0.4). Operational counts only: no
 * names, emails, titles or other tenant content.
 */
export async function renderMetrics(): Promise<string> {
  const out: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", samples: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) {
      const l = Object.entries(labels).map(([k, val]) => `${k}="${esc(val)}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(v) ? v : 0}`);
    }
  };
  const dep = async (fn: () => Promise<unknown>) => (await timed(fn).then(() => 1).catch(() => 0));
  const [database, redis, storage] = await Promise.all([dep(() => db().execute(sql`select 1`)), dep(() => getRedis().ping()), dep(async () => (await getStorageDriver()).healthCheck())]);
  metric("researchmate_up", "The web process is serving requests.", "gauge", [[{}, 1]]);
  metric("researchmate_dependency_up", "Whether a dependency answered a health check.", "gauge", [[{ dependency: "database" }, database], [{ dependency: "redis" }, redis], [{ dependency: "storage" }, storage]]);
  const age = await workerHeartbeatAge();
  metric("researchmate_worker_up", "A worker reported a heartbeat in the last 2 minutes.", "gauge", [[{}, age === null ? 0 : 1]]);
  metric("researchmate_worker_heartbeat_age_seconds", "Seconds since the last worker heartbeat (-1 when none).", "gauge", [[{}, age === null ? -1 : Math.round(age)]]);

  const qs: [Record<string, string>, number][] = [];
  if (redis) {
    for (const q of queues()) {
      const c = await timed(() => q.getJobCounts("waiting", "active", "delayed", "failed", "completed")).catch(() => null);
      if (c) for (const [state, n] of Object.entries(c)) qs.push([{ queue: q.name, state }, n]);
    }
  }
  metric("researchmate_queue_jobs", "BullMQ jobs by queue and state.", "gauge", qs);

  if (database) {
    const [r] = (await db().execute(sql`select
        (select count(*) from users where status = 'active')::int as users,
        (select count(*) from organizations where deleted_at is null)::int as organizations,
        (select count(*) from organizations where deleted_at is not null)::int as organizations_pending_purge,
        (select count(*) from research_projects where archived_at is null)::int as projects,
        (select count(*) from notifications where email_status = 'pending')::int as notification_emails_pending,
        (select count(*) from notifications where email_status = 'failed' and created_at > now() - interval '1 day')::int as notification_emails_failed_24h,
        (select coalesce(extract(epoch from now() - min(created_at)), 0) from document_exports where status in ('queued', 'running'))::float as export_oldest_pending_seconds,
        (select count(*) from document_exports where status = 'failed' and created_at > now() - interval '1 day')::int as exports_failed_24h,
        (select count(*) from ai_runs where status in ('queued', 'running'))::int as ai_runs_in_flight,
        (select count(*) from ai_runs where status = 'failed' and created_at > now() - interval '1 day')::int as ai_runs_failed_24h,
        (select count(*) from payments where status = 'pending')::int as payments_pending,
        (select count(*) from payments where status = 'failed' and created_at > now() - interval '1 day')::int as payments_failed_24h,
        (select count(*) from file_processing_jobs where status in ('queued', 'running'))::int as file_jobs_in_flight,
        (select coalesce(sum(fv.size_bytes), 0) from file_versions fv join files f on f.id = fv.file_id where fv.purged_at is null)::float as stored_bytes,
        (select count(*) from security_events where type = 'login.failed' and created_at > now() - interval '1 hour')::int as login_failures_1h`)) as unknown as Record<string, number>[];
    const v = r!;
    metric("researchmate_users", "Active user accounts.", "gauge", [[{}, Number(v.users)]]);
    metric("researchmate_organizations", "Organizations by state.", "gauge", [[{ state: "active" }, Number(v.organizations)], [{ state: "pending_purge" }, Number(v.organizations_pending_purge)]]);
    metric("researchmate_projects_active", "Projects that are not archived.", "gauge", [[{}, Number(v.projects)]]);
    metric("researchmate_notification_emails_pending", "Notification emails waiting for delivery.", "gauge", [[{}, Number(v.notification_emails_pending)]]);
    metric("researchmate_notification_emails_failed_24h", "Notification emails that failed in the last day.", "gauge", [[{}, Number(v.notification_emails_failed_24h)]]);
    metric("researchmate_document_export_oldest_pending_seconds", "Age of the oldest queued or running document export.", "gauge", [[{}, Math.round(Number(v.export_oldest_pending_seconds))]]);
    metric("researchmate_document_exports_failed_24h", "Document exports that failed in the last day.", "gauge", [[{}, Number(v.exports_failed_24h)]]);
    metric("researchmate_ai_runs_in_flight", "AI runs queued or running.", "gauge", [[{}, Number(v.ai_runs_in_flight)]]);
    metric("researchmate_ai_runs_failed_24h", "AI runs that failed in the last day.", "gauge", [[{}, Number(v.ai_runs_failed_24h)]]);
    metric("researchmate_payments_pending", "Payments awaiting confirmation.", "gauge", [[{}, Number(v.payments_pending)]]);
    metric("researchmate_payments_failed_24h", "Payments that failed in the last day.", "gauge", [[{}, Number(v.payments_failed_24h)]]);
    metric("researchmate_file_jobs_in_flight", "Text-extraction jobs queued or running.", "gauge", [[{}, Number(v.file_jobs_in_flight)]]);
    metric("researchmate_stored_bytes", "Bytes of research files held in storage.", "gauge", [[{}, Number(v.stored_bytes)]]);
    metric("researchmate_login_failures_1h", "Failed sign-ins in the last hour (brute-force indicator).", "gauge", [[{}, Number(v.login_failures_1h)]]);
  }
  const mem = process.memoryUsage();
  metric("process_resident_memory_bytes", "Resident memory of the web process.", "gauge", [[{}, mem.rss]]);
  metric("process_uptime_seconds", "Uptime of the web process.", "gauge", [[{}, Math.round(process.uptime())]]);
  return `${out.join("\n")}\n`;
}

/** For the administrators' System page: dependencies, worker and queues. */
export async function systemSnapshot() {
  const dep = async (fn: () => Promise<unknown>) => (await timed(fn).then(() => "ok" as const).catch(() => "error" as const));
  const [database, redis, storage] = await Promise.all([dep(() => db().execute(sql`select 1`)), dep(() => getRedis().ping()), dep(async () => (await getStorageDriver()).healthCheck())]);
  const workerAgeSeconds = await workerHeartbeatAge().catch(() => null);
  const queueCounts: { queue: string; counts: Record<string, number> }[] = [];
  if (redis === "ok") {
    for (const q of queues()) {
      const c = await timed(() => q.getJobCounts("waiting", "active", "delayed", "failed")).catch(() => null);
      if (c) queueCounts.push({ queue: q.name, counts: c });
    }
  }
  return { database, redis, storage, workerAgeSeconds, queues: queueCounts };
}
