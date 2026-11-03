import Link from "next/link";
import { ProjectNav } from "@/components/project-nav";
import { ProgressRule, StatusTag } from "@/components/ui";
import { loadProject } from "@/server/plan";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { project: p, archived } = await loadProject(projectId);
  return (
    <>
      <header className="mb-5">
        <p className="no-print text-sm">
          <Link href="/app/projects" className="text-graphite">Projects</Link>
        </p>
        <h1 className="mt-1 text-[2rem]">{p.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-graphite">
          <StatusTag status={p.status} />
          <ProgressRule value={p.progressPercent} label={p.progressSource === "tasks" ? "Progress (from tasks)" : "Progress"} />
        </div>
      </header>
      <ProjectNav projectId={p.id} />
      {archived && <p className="mb-8 rounded-md border border-rule bg-rule-soft px-4 py-3 text-sm">This project is archived and read-only.</p>}
      {children}
    </>
  );
}
