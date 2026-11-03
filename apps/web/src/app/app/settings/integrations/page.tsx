import { canUseFeature } from "@researchmate/entitlements";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Notice, PlanNotice, Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { driveAction } from "@/server/actions/ai";
import { db, driveConfigured, driveService, fileService, projectService } from "@/server/services";
import { requireWorkspace } from "@/server/session";
import { IntegrationSettings } from "@/components/integration-settings";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; q?: string }> }) {
  const { session, org } = await requireWorkspace();
  const q = await searchParams;
  const entitled = await canUseFeature(db(), org.organizationId, "integrations.google_drive");
  const configured = driveConfigured();
  const svc = configured && entitled ? await driveService() : null;
  const conn = svc ? await svc.connection(session.user.id, org.organizationId) : null;
  let listing: Awaited<ReturnType<NonNullable<typeof svc>["listFiles"]>> | null = null;
  let listError: string | null = null;
  if (svc && conn?.status === "active") {
    try {
      listing = await svc.listFiles(session.user.id, org.organizationId, { search: q.q });
    } catch (err) {
      listError = (err as Error).message;
    }
  }
  const [jobs, projects] = await Promise.all([svc ? svc.listJobs(session.user.id, org.organizationId) : [], projectService().list(session.user.id, org.organizationId)]);
  const libraryFiles = conn?.status === "active" ? await (await fileService()).list(session.user.id, org.organizationId, {}) : [];
  const running = jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <>
      <PageHeader title="Integrations" />
      <AutoRefresh active={running} />
      {q.connected && <p role="status" className="mb-6 rounded-md border border-green/30 bg-green-wash px-3 py-2 text-sm text-green-dark">Google Drive connected.</p>}
      {q.error && <p role="alert" className="mb-6 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">{q.error}</p>}

      <Section title="Google Drive" description="Import PDFs, Word files and Google Docs into your projects, and export files back to Drive. Imported copies count toward your storage; files left in Drive don't.">
        {!entitled ? (
          <PlanNotice>Google Drive is not included in your organization's plan.</PlanNotice>
        ) : !configured ? (
          <Notice>Google Drive hasn't been set up on this server yet (an administrator needs to add Google OAuth credentials).</Notice>
        ) : !conn ? (
          <div className="grid max-w-2xl gap-3 text-sm">
            <p>ResearchMate asks only for access to files you choose to open or create with it. It can't read the rest of your Drive.</p>
            <a href="/api/integrations/google/start" className="btn btn-primary w-fit">Connect Google Drive</a>
          </div>
        ) : (
          <div className="grid gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <p>
                Connected as <strong>{conn.accountEmail || "your Google account"}</strong> since {formatDateTime(conn.connectedAt)}
                {conn.status === "reauth_required" && <span className="ml-2 text-margin">Access expired. <a href="/api/integrations/google/start">Reconnect</a></span>}
              </p>
              <ActionForm action={driveAction} submitLabel="Disconnect" variant="danger" className="flex">
                <input type="hidden" name="intent" value="disconnect" />
              </ActionForm>
            </div>
            {libraryFiles.length > 0 && (
              <div className="max-w-3xl rounded-md border border-rule bg-sheet p-4">
                <h3 className="mb-3 font-sans text-base font-semibold">Export a file to Drive</h3>
                <ActionForm action={driveAction} submitLabel="Export" className="grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="intent" value="export" />
                  <div className="field">
                    <label htmlFor="x-file">File</label>
                    <select id="x-file" name="fileId" className="input">
                      {libraryFiles.map((f) => <option key={f.id} value={f.id}>{f.originalName}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="x-folder">Drive folder ID (optional)</label>
                    <input id="x-folder" name="folderId" className="input" pattern="[A-Za-z0-9_-]{10,200}" placeholder="From the folder's URL; empty = My Drive" />
                  </div>
                </ActionForm>
              </div>
            )}
            {listError && <p role="alert" className="text-sm text-margin">{listError}</p>}
            {listing && (
              <div>
                <form method="get" className="mb-3 flex max-w-md gap-2">
                  <label htmlFor="d-q" className="sr-only">Search Drive files</label>
                  <input id="d-q" name="q" className="input" placeholder="Search by name" defaultValue={q.q ?? ""} />
                  <button className="btn btn-quiet">Search</button>
                </form>
                {listing.scope === "drive.file" && <p className="mb-3 text-xs text-graphite">With limited access, only files created with or previously opened in ResearchMate appear here.</p>}
                {listing.files.length === 0 ? (
                  <p className="text-sm text-graphite">No files to show.</p>
                ) : (
                  <ul className="ruled max-w-4xl text-sm">
                    {listing.files.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                        <span>
                          {f.name} <span className="text-xs text-graphite">· {f.mimeType.replace("application/vnd.google-apps.", "Google ").replace("application/", "")}{f.modifiedTime ? ` · ${formatDateTime(new Date(f.modifiedTime))}` : ""}</span>
                          {f.imported && <span className="ml-2"><Tag tone="done">Imported</Tag></span>}
                        </span>
                        <ActionForm action={driveAction} submitLabel={f.imported ? "Update copy" : "Import"} variant="quiet" className="flex items-center gap-2">
                          <input type="hidden" name="intent" value="import" />
                          <input type="hidden" name="externalId" value={f.id} />
                          <label className="sr-only" htmlFor={`p-${f.id}`}>Project for {f.name}</label>
                          <select id={`p-${f.id}`} name="projectId" className="input max-w-52 py-1 text-sm">
                            <option value="">File library (no project)</option>
                            {projects.filter((p) => p.status !== "archived").map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                          </select>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      {jobs.length > 0 && (
        <Section title="Recent transfers">
          <ul className="ruled max-w-3xl text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {j.kind === "import" ? "Import" : "Export"} · {formatDateTime(j.createdAt)}
                  {j.result && "duplicate" in j.result && j.result.duplicate ? " · already up to date" : ""}
                  {j.error ? <span className="block text-xs text-margin">{j.error}</span> : null}
                </span>
                <Tag tone={j.status === "succeeded" ? "done" : j.status === "failed" ? "blocked" : "in_progress"}>{j.status}</Tag>
              </li>
            ))}
          </ul>
        </Section>
      )}
          <IntegrationSettings userId={session.user.id} organizationId={org.organizationId} canManage={org.permissions.has("org.settings.manage")} />
    </>
  );
}
