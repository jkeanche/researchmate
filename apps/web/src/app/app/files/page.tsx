import { formatBytes, getLimitStatus, limitOf } from "@researchmate/entitlements";
import { env } from "@researchmate/shared";
import { ACCEPT_ATTRIBUTE } from "@researchmate/storage";
import { FileUploader } from "@/components/client-bits";
import { FileList } from "@/components/file-list";
import { Meter, PageHeader, Section } from "@/components/ui";
import { db, fileService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Files" };

export default async function FilesPage() {
  const { session, org } = await requireWorkspace();
  const [files, status] = await Promise.all([
    fileService().then((s) => s.list(session.user.id, org.organizationId)),
    getLimitStatus(db(), org.organizationId),
  ]);
  const lim = Object.fromEntries(status.limits.map((l) => [l.key, l]));
  const maxFile = Math.min(limitOf(status.entitlements, "files.max_size_bytes") ?? Infinity, env().MAX_UPLOAD_SIZE_MB * 1024 * 1024);
  const filesFull = lim["files.max"]!.limit !== null && lim["files.max"]!.used >= lim["files.max"]!.limit!;
  const storageFull = lim["storage.max_bytes"]!.limit !== null && lim["storage.max_bytes"]!.used >= lim["storage.max_bytes"]!.limit!;
  const disabledReason = !org.permissions.has("files.upload")
    ? "Your role can't upload to the organization library. Upload inside a project you work on instead."
    : filesFull
      ? `The ${status.entitlements.planName} plan allows ${lim["files.max"]!.limit} file${lim["files.max"]!.limit === 1 ? "" : "s"}. Delete a file or upgrade to add more.`
      : storageFull
        ? "Storage is full. Delete files or upgrade to add more."
        : null;
  const isAdmin = org.permissions.has("org.settings.manage");

  return (
    <>
      <PageHeader title="Files" description="Everything uploaded to this organization that you can access, including files inside your projects." />
      <div className="mb-10 grid max-w-xl gap-4 sm:grid-cols-2">
        <Meter label="Files" used={lim["files.max"]!.used} limit={lim["files.max"]!.limit} format={String} />
        <Meter label="Storage" used={lim["storage.max_bytes"]!.used} limit={lim["storage.max_bytes"]!.limit} format={formatBytes} />
      </div>
      <Section title="Upload to the library" description="Library files aren't tied to a project. To attach a file to a project, upload it from the project page.">
        <FileUploader organizationId={org.organizationId} accept={ACCEPT_ATTRIBUTE} maxBytes={maxFile} disabledReason={disabledReason} />
        {!status.entitlements.values["ai.document_processing"] && (
          <p className="mt-3 text-sm text-graphite">Files are stored as they are. Text extraction and AI processing aren't included in the {status.entitlements.planName} plan.</p>
        )}
      </Section>
      <Section title="All files">
        <FileList rows={files} showProject canDelete={(f) => !f.projectId && (isAdmin || f.uploadedByUserId === session.user.id)} />
      </Section>
    </>
  );
}
