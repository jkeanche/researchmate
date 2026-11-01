import { RESEARCH_TYPE_LABELS } from "@researchmate/research";
import Link from "next/link";
import { EmptyState, PageHeader, ProgressRule, StatusTag } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { projectService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const { session, org } = await requireWorkspace();
  const projects = await projectService().list(session.user.id, org.organizationId);
  const canCreate = org.permissions.has("projects.create");
  const [current, archived] = [projects.filter((p) => p.status !== "archived"), projects.filter((p) => p.status === "archived")];

  return (
    <>
      <PageHeader title="Projects" description={`Research projects in ${org.organizationName} that you can access.`} actions={canCreate ? <Link href="/app/projects/new" className="btn btn-primary">New project</Link> : null} />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" body="Create a project to start organising your research questions, files and schedule." action={canCreate ? { href: "/app/projects/new", label: "Create a project" } : undefined} />
      ) : (
        <>
          <ProjectTable rows={current} />
          {archived.length > 0 && (
            <details className="mt-10">
              <summary className="cursor-pointer text-sm text-graphite">Archived projects ({archived.length})</summary>
              <div className="mt-4">
                <ProjectTable rows={archived} />
              </div>
            </details>
          )}
        </>
      )}
    </>
  );
}

function ProjectTable({ rows }: { rows: Awaited<ReturnType<ReturnType<typeof projectService>["list"]>> }) {
  if (rows.length === 0) return <p className="text-sm text-graphite">No current projects.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-rule text-graphite">
          <tr>
            <th className="py-2 pr-4 font-medium">Title</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Progress</th>
            <th className="py-2 font-medium">Due</th>
          </tr>
        </thead>
        <tbody className="[&_tr]:border-b [&_tr]:border-rule-soft">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="py-3 pr-4">
                <Link href={`/app/projects/${p.id}`} className="font-semibold no-underline hover:underline">{p.title}</Link>
              </td>
              <td className="py-3 pr-4 text-graphite">{RESEARCH_TYPE_LABELS[p.researchType as keyof typeof RESEARCH_TYPE_LABELS]}</td>
              <td className="py-3 pr-4"><StatusTag status={p.status} /></td>
              <td className="py-3 pr-4"><ProgressRule value={p.progressPercent} label="Progress" /></td>
              <td className="py-3 tabular-nums text-graphite">{formatDate(p.expectedCompletionDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
