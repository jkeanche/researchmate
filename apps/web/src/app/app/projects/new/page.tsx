import { getLimitStatus } from "@researchmate/entitlements";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ProjectFields } from "@/components/project-fields";
import { PageHeader } from "@/components/ui";
import { createProjectAction } from "@/server/actions/workspace";
import { db } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "New project" };

export default async function NewProjectPage() {
  const { org } = await requireWorkspace();
  const status = await getLimitStatus(db(), org.organizationId);
  const projects = status.limits.find((l) => l.key === "projects.max")!;
  const atLimit = projects.limit !== null && projects.used >= projects.limit;

  if (!org.permissions.has("projects.create")) {
    return (
      <>
        <PageHeader title="New project" />
        <p className="text-graphite">Your role in {org.organizationName} doesn't allow creating projects. Ask an organization admin.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New project" description="Only the title and research type are required. Everything else can be added later." />
      {atLimit ? (
        <div className="max-w-xl rounded-md border border-amber/30 bg-amber-wash px-4 py-3 text-sm text-amber">
          <p>
            The {status.entitlements.planName} plan allows {projects.limit} project{projects.limit === 1 ? "" : "s"}, and {org.organizationName} already has {projects.used}. Archived projects still count.
          </p>
          <Link href="/app/settings/organization" className="mt-2 inline-block font-semibold underline">See plan options</Link>
        </div>
      ) : (
        <div className="max-w-2xl">
          <ActionForm action={createProjectAction} submitLabel="Create project" pendingLabel="Creating…" className="grid gap-6">
            <ProjectFields />
          </ActionForm>
        </div>
      )}
    </>
  );
}
