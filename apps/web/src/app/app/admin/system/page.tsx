import { env, platformModelFromEnv } from "@researchmate/shared";
import { AdminButton, KeyValue, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { systemSnapshot } from "@/server/metrics";
import { adminService, driveConfigured, paymentService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "System · Administration" };

const ok = (v: boolean, yes = "configured", no = "not configured") => <Tag tone={v ? "in_progress" : "todo"}>{v ? yes : no}</Tag>;

export default async function AdminSystemPage() {
  const s = await requireSession();
  const e = env();
  const [sys, actors] = await Promise.all([systemSnapshot(), adminService().listApifyActors(s.user.id)]);
  const providers = paymentService().available();
  const model = platformModelFromEnv(e);
  const health = (v: string) => <Tag tone={v === "ok" ? "in_progress" : "blocked"}>{v === "ok" ? "OK" : "not answering"}</Tag>;

  return (
    <>
      <PageHeader title="System" description="Service health and which integrations are configured. Settings live in the server's environment file (/etc/researchmate/researchmate.env on a native install); secrets are never shown here." />

      <div className="grid gap-x-10 lg:grid-cols-2">
        <Section title="Health">
          <KeyValue
            rows={[
              ["Database", health(sys.database)],
              ["Redis (queues, rate limits)", health(sys.redis)],
              ["File storage", <span key="s">{health(sys.storage)} <span className="text-xs text-graphite">{e.STORAGE_DRIVER === "s3" ? "S3-compatible bucket" : "local disk"}</span></span>],
              ["Background worker", sys.workerAgeSeconds === null ? <Tag key="w" tone="blocked">no heartbeat — emails, exports and extraction are waiting</Tag> : <Tag key="w" tone="in_progress">last seen {Math.round(sys.workerAgeSeconds)}s ago</Tag>],
            ]}
          />
        </Section>

        <Section title="Configuration">
          <KeyValue
            rows={[
              ["Site address", e.APP_URL],
              ["Outgoing email", e.EMAIL_HOST ? <span key="m">{ok(true)} <span className="text-xs text-graphite">{e.EMAIL_HOST}:{e.EMAIL_PORT} · from {e.EMAIL_FROM}</span></span> : ok(false)],
              ["Email verification", e.REQUIRE_EMAIL_VERIFICATION ? "required" : "not required"],
              ["Payments", providers.length ? providers.map((p) => `${p.name} (${p.currencies.join(", ")})`).join(" · ") : ok(false, "", "no provider configured")],
              ["Platform AI", model ? <span key="ai">{ok(true, "on")} <span className="text-xs text-graphite">{model.providerKey} · {model.modelId}</span></span> : ok(false, "", "off")],
              ["Google Drive", ok(driveConfigured())],
              ["Apify", ok(!!e.APIFY_TOKEN)],
              ["Malware scanning", e.CLAMAV_HOST ? <span key="c">{ok(true, "on")} <span className="text-xs text-graphite">ClamAV {e.CLAMAV_HOST}:{e.CLAMAV_PORT}</span></span> : ok(false, "", "off")],
              ["OCR for scanned PDFs", e.OCR_ENABLED ? "on" : "off"],
              ["Upload size limit", `${e.MAX_UPLOAD_SIZE_MB} MB`],
              ["Metrics endpoint", ok(!!e.METRICS_TOKEN, "token set", "disabled (no token)")],
            ]}
          />
        </Section>
      </div>

      <Section title="Job queues" description="Waiting work piles up here when the worker is stopped; failed jobs have used up their retries.">
        <Table head={["Queue", "Waiting", "Running", "Delayed", "Failed"]} empty="Redis isn't answering, so queues can't be read.">
          {sys.queues.map((q) => (
            <tr key={q.queue}>
              <td className="font-mono text-xs">{q.queue}</td>
              <td className="tabular-nums">{q.counts.waiting ?? 0}</td>
              <td className="tabular-nums">{q.counts.active ?? 0}</td>
              <td className="tabular-nums">{q.counts.delayed ?? 0}</td>
              <td className="tabular-nums">{q.counts.failed ? <Tag tone="blocked">{q.counts.failed}</Tag> : 0}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Apify Actors" description="The only Actors organizations may run. Check an Actor's current input schema and pricing on Apify before enabling it; organizations still need the Apify feature on their plan and their own Apify connection.">
        <Table head={["Actor", "Limits", "Notes", ""]} empty="No Actors on the allowlist.">
          {actors.map((a) => (
            <tr key={a.id}>
              <td>{a.name} {a.enabled ? <Tag tone="in_progress">enabled</Tag> : <Tag tone="todo">disabled</Tag>}<span className="block font-mono text-xs text-graphite">{a.actorId}</span></td>
              <td className="text-xs">{a.maxItems} items · {a.timeoutSecs}s · {a.memoryMbytes} MB</td>
              <td className="max-w-xs text-xs text-graphite">{a.notes}</td>
              <td><AdminButton intent={a.enabled ? "apify.disable" : "apify.enable"} id={a.id} label={a.enabled ? "Disable" : "Enable"} /></td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
