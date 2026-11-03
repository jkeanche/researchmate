import { formatUsd } from "@researchmate/billing";
import { canUseFeature } from "@researchmate/entitlements";
import { ActionForm, Field } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { webResearchAction } from "@/server/actions/integrations";
import { apifyService, db, webCaptureService } from "@/server/services";

const RUN_TONE: Record<string, string> = { queued: "todo", running: "in_progress", succeeded: "done", failed: "blocked", aborted: "skipped", timed_out: "blocked" };

/** Capture approved web pages and run approved Apify Actors for a project. */
export async function WebResearch({ userId, projectId, organizationId, canEdit }: { userId: string; projectId: string; organizationId: string; canEdit: boolean }) {
  const [domains, apifyOk, actors, runs] = await Promise.all([webCaptureService().then((w) => w.domains(organizationId)), canUseFeature(db(), organizationId, "integrations.apify"), apifyService().actors(), apifyService().list(userId, projectId)]);
  const all = [...domains.platform, ...domains.organization];
  const hidden = <input type="hidden" name="projectId" value={projectId} />;
  return (
    <>
      <AutoRefresh active={runs.some((r) => r.status === "queued" || r.status === "running")} />
      <Section title="Capture a web page" description={all.length ? `From approved websites: ${all.join(", ")}. A dated text snapshot is saved to the project and the page is added to the library with its address and access date.` : "No websites are approved yet. An organization admin can approve them in Settings → Integrations."}>
        {canEdit && all.length > 0 && (
          <ActionForm action={webResearchAction} submitLabel="Capture" resetOnSuccess className="flex max-w-2xl flex-wrap items-end gap-2">
            {hidden}
            <input type="hidden" name="intent" value="capture" />
            <div className="min-w-72 flex-1"><Field id="cap-url" label="Page address" name="url" type="url" required placeholder="https://www.who.int/…" /></div>
          </ActionForm>
        )}
      </Section>

      {apifyOk && actors.length > 0 && (
        <Section title="Web research with Apify" description="Approved Actors only, with limits on items, time and cost. Results are untrusted web data: check them before relying on them.">
          {canEdit && (
            <div className="mb-4 grid gap-3 md:grid-cols-2">
              {actors.map((a) => (
                <div key={a.key} className="rounded-md border border-rule bg-sheet p-4">
                  <h3 className="font-sans text-base font-semibold">{a.name}</h3>
                  <p className="mb-2 text-sm text-graphite">{a.description} Up to {a.maxItems} items, {Math.round(a.timeoutSecs / 60)} min, {formatUsd(a.maxChargeMicros)} per run.</p>
                  <ActionForm action={webResearchAction} submitLabel="Run" variant="quiet" className="grid gap-2">
                    {hidden}
                    <input type="hidden" name="intent" value="apify_run" />
                    <input type="hidden" name="actorKey" value={a.key} />
                    {Object.entries(a.inputFields).map(([k, f]) =>
                      f.type === "url[]" || f.type === "string[]" || (f.type === "string" && (f.max ?? 0) > 200) ? (
                        <div key={k} className="field">
                          <label htmlFor={`ap-${a.key}-${k}`}>{f.description ?? k}{f.type.endsWith("[]") ? " (one per line)" : ""}</label>
                          <textarea id={`ap-${a.key}-${k}`} name={`in_${k}`} className="input min-h-14" required={f.required} />
                        </div>
                      ) : (
                        <Field key={k} id={`ap-${a.key}-${k}`} label={f.description ?? k} name={`in_${k}`} type={f.type === "number" ? "number" : "text"} max={f.max} required={f.required} />
                      ),
                    )}
                  </ActionForm>
                </div>
              ))}
            </div>
          )}
          <ul className="grid gap-3">
            {runs.map((r) => (
              <li key={r.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{actors.find((a) => a.key === r.actorKey)?.name ?? r.actorKey} <span className="font-normal text-graphite">· {formatDateTime(r.createdAt)}{r.itemCount != null ? ` · ${r.itemCount} results` : ""}{r.costMicros != null ? ` · Apify cost ${formatUsd(r.costMicros)}` : ""}{r.funding === "platform" ? ` · charged ${formatUsd(r.chargeMicros)}` : " · your Apify account"}</span></p>
                  <Tag tone={RUN_TONE[r.status]!}>{r.status.replace("_", " ")}</Tag>
                </div>
                {r.error && <p className="mt-1 text-margin">{r.error}</p>}
                {r.results && r.results.length > 0 && (
                  <ul className="mt-2 grid gap-1">
                    {r.results.slice(0, 20).map((it, i) => (
                      <li key={i} className="flex items-start justify-between gap-2 border-t border-rule-soft pt-1">
                        <span className="min-w-0">
                          <span className="font-medium">{String(it.title || it.url || "Result")}</span>
                          {it.url ? <span className="block truncate text-xs text-graphite">{String(it.url)}</span> : null}
                          {it.snippet || it.text ? <span className="block text-xs text-graphite">{String(it.snippet ?? it.text).slice(0, 220)}</span> : null}
                        </span>
                        {canEdit && it.url ? (
                          <ActionForm action={webResearchAction} submitLabel="Add to library" variant="quiet" className="flex shrink-0">
                            {hidden}
                            <input type="hidden" name="intent" value="apify_add" />
                            <input type="hidden" name="runId" value={r.id} />
                            <input type="hidden" name="index" value={i} />
                          </ActionForm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
