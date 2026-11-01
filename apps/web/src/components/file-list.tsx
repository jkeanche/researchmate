import { formatBytes } from "@researchmate/entitlements";
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { deleteFileAction } from "@/server/actions/workspace";
import { ConfirmAction } from "./client-bits";

export interface FileRow {
  id: string;
  originalName: string;
  mimeType: string;
  projectId: string | null;
  projectTitle: string | null;
  currentVersion: number;
  updatedAt: Date;
  uploadedBy: string | null;
  uploadedByUserId: string;
  sizeBytes: number;
}

export function FileList({ rows, showProject = false, canDelete }: { rows: FileRow[]; showProject?: boolean; canDelete: (row: FileRow) => boolean }) {
  if (rows.length === 0) return <p className="text-sm text-graphite">No files yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-sm">
        <thead className="border-b border-rule text-graphite">
          <tr>
            <th className="py-2 pr-4 font-medium">Name</th>
            {showProject && <th className="py-2 pr-4 font-medium">Project</th>}
            <th className="py-2 pr-4 font-medium">Size</th>
            <th className="py-2 pr-4 font-medium">Updated</th>
            <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="[&_tr]:border-b [&_tr]:border-rule-soft">
          {rows.map((f) => (
            <tr key={f.id}>
              <td className="max-w-[22rem] py-3 pr-4">
                <a href={`/api/files/${f.id}/download`} className="block truncate font-medium no-underline hover:underline" title={f.originalName}>{f.originalName}</a>
                <span className="text-xs text-graphite">
                  {f.uploadedBy ? `Uploaded by ${f.uploadedBy}` : null}
                  {f.currentVersion > 1 ? `, version ${f.currentVersion}` : null}
                </span>
              </td>
              {showProject && (
                <td className="py-3 pr-4 text-graphite">
                  {f.projectId ? <Link href={`/app/projects/${f.projectId}`} className="hover:underline">{f.projectTitle}</Link> : "Library"}
                </td>
              )}
              <td className="py-3 pr-4 tabular-nums text-graphite">{formatBytes(f.sizeBytes)}</td>
              <td className="py-3 pr-4 tabular-nums text-graphite">{formatDate(f.updatedAt)}</td>
              <td className="py-3 text-right">
                <div className="flex justify-end gap-2">
                  <a href={`/api/files/${f.id}/download`} className="btn btn-quiet px-3 py-1.5 text-sm">Download</a>
                  {canDelete(f) && (
                    <ConfirmAction
                      action={deleteFileAction}
                      fields={{ fileId: f.id, projectId: f.projectId ?? "" }}
                      label="Delete"
                      confirmText={`Delete “${f.originalName}”? It will be removed from your workspace and permanently erased after the retention period.`}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
