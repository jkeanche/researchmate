import { ActionForm, Field } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { PlanNotice, Tag } from "@/components/plan-ui";
import { Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { documentAction } from "@/server/actions/documents";
import { loadDocument } from "@/server/documents";
import { documentService } from "@/server/services";

export const metadata = { title: "Versions and export" };

const TONE = { pass: "done", warn: "awaiting_approval", fail: "blocked" } as const;
const size = (n: number | null) => (n == null ? "" : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} kB`);

export default async function VersionsPage({ params }: { params: Promise<{ projectId: string; documentId: string }> }) {
  const { projectId, documentId } = await params;
  const d = await loadDocument(projectId, documentId);
  const docs = await documentService();
  const [versions, exports, gen] = await Promise.all([docs.versions(d.session.user.id, documentId), docs.exports(d.session.user.id, documentId), docs.generationTier(d.project.organizationId)]);
  const active = exports.some((e) => e.x.status === "queued" || e.x.status === "running");
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="documentId" value={documentId} />
    </>
  );
  return (
    <>
      <AutoRefresh active={active} />
      <Section title="Export" description="DOCX is the editable master. PDF is rendered from it with LibreOffice and checked page by page against the specification. Each export records the version it was made from.">
        {gen.tier === "none" ? (
          <PlanNotice>Exporting is not included in the {gen.planName} plan.</PlanNotice>
        ) : d.canEdit ? (
          <div className="flex flex-wrap gap-3">
            {(["docx", "pdf"] as const).map((f) => (
              <ActionForm key={f} action={documentAction} submitLabel={`Export ${f.toUpperCase()}`} variant={f === "pdf" ? "primary" : "quiet"} className="grid gap-2">
                {hidden}
                <input type="hidden" name="intent" value="export" />
                <input type="hidden" name="format" value={f} />
              </ActionForm>
            ))}
          </div>
        ) : null}
        <ul className="mt-4 grid gap-3">
          {exports.map(({ x, number, validation }) => (
            <li key={x.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  {x.format.toUpperCase()} · version {number} <span className="font-normal text-graphite">· {formatDateTime(x.createdAt)}{x.pageCount ? ` · ${x.pageCount} pages` : ""} {size(x.sizeBytes)}</span>
                </p>
                <span className="flex items-center gap-2">
                  {validation && <Tag tone={validation.passed ? "done" : "blocked"}>{validation.passed ? "Meets the specification" : "Doesn't meet the specification"}</Tag>}
                  {x.status === "succeeded" ? (
                    <a className="btn btn-quiet" href={`/api/documents/exports/${x.id}`} aria-label={`Download ${x.format.toUpperCase()} version ${number}`}>Download</a>
                  ) : (
                    <Tag tone={x.status === "failed" ? "blocked" : "in_progress"}>{x.status === "queued" ? "Queued" : x.status === "running" ? "Rendering…" : "Failed"}</Tag>
                  )}
                </span>
              </div>
              {x.error && <p className="mt-2 text-margin">{x.error}</p>}
              {validation && (
                <details className="mt-2" open={!validation.passed}>
                  <summary className="cursor-pointer text-graphite">Checks ({validation.checks.filter((c) => c.status === "pass").length} of {validation.checks.length} pass)</summary>
                  <ul className="mt-2 grid gap-1">
                    {validation.checks.map((c) => (
                      <li key={c.key} className="flex items-start gap-2">
                        <Tag tone={TONE[c.status]}>{c.status === "pass" ? "Pass" : c.status === "warn" ? "Check" : "Fails"}</Tag>
                        <span><span className="font-semibold">{c.label}.</span> {c.detail}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Versions (${versions.length})`} description="Snapshots of every section. Restoring a version first saves the current text as a version, so nothing is lost.">
        {d.canEdit && (
          <ActionForm action={documentAction} submitLabel="Save a version" variant="quiet" resetOnSuccess className="mb-4 flex flex-wrap items-end gap-2">
            {hidden}
            <input type="hidden" name="intent" value="save_version" />
            <Field id="v-label" label="Label" name="label" maxLength={200} placeholder="e.g. Sent to supervisor" />
          </ActionForm>
        )}
        <ul className="grid gap-2 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule bg-sheet px-3 py-2">
              <span>
                <span className="font-semibold">Version {v.number}</span> {v.label && `· ${v.label}`} <span className="text-graphite">· {v.wordCount.toLocaleString("en")} words · {v.by ?? "Former member"} · {formatDateTime(v.createdAt)}</span>
              </span>
              {d.canEdit && (
                <ActionForm action={documentAction} submitLabel="Restore" variant="quiet" className="flex">
                  {hidden}
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="versionId" value={v.id} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
