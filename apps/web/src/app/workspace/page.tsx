import { listScheduledDeletions, listUserOrganizations } from "@researchmate/tenancy";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { Wordmark } from "@/components/brand";
import { logoutAction } from "@/server/actions/auth";
import { restoreOrganizationAction } from "@/server/actions/retention";
import { createOrganizationAction } from "@/server/actions/workspace";
import { db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Choose a workspace" };
export const dynamic = "force-dynamic";

/**
 * Shown when the user belongs to no active workspace (e.g. they deleted their
 * only one). Lives outside /app, whose layout requires a workspace.
 */
export default async function WorkspacePage() {
  const session = await requireSession();
  const [orgs, scheduled] = await Promise.all([listUserOrganizations(db(), session.user.id), listScheduledDeletions(db(), session.user.id)]);
  if (orgs.length > 0) redirect("/app");
  return (
    <div className="flex min-h-screen flex-col items-center px-5 py-10">
      <div className="mb-8">
        <Wordmark />
      </div>
      <main className="margin-rule w-full max-w-lg rounded-md border border-rule bg-sheet py-8 pr-7 pl-10">
        <h1 className="text-2xl font-semibold">You don't have a workspace</h1>
        {scheduled.length > 0 && (
          <section className="mt-6">
            <h2 className="font-semibold">Scheduled for deletion</h2>
            <p className="mt-1 text-sm text-graphite">Restore one to keep everything in it.</p>
            <ul className="mt-3 grid gap-2">
              {scheduled.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule px-3 py-2 text-sm">
                  <span>
                    <strong>{o.name}</strong> — deleted permanently on {o.purgeAfter?.toISOString().slice(0, 10)}
                  </span>
                  <ActionForm action={restoreOrganizationAction} submitLabel={`Restore ${o.name}`} variant="quiet" className="flex">
                    <input type="hidden" name="organizationId" value={o.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="mt-6">
          <h2 className="font-semibold">Start a new workspace</h2>
          <div className="mt-3">
            <ActionForm action={createOrganizationAction} submitLabel="Create workspace" pendingLabel="Creating…">
              <Field label="Workspace name" name="name" required minLength={2} maxLength={80} placeholder="e.g. My research" />
            </ActionForm>
          </div>
        </section>
        <form action={logoutAction} className="mt-8">
          <button className="text-sm text-graphite underline-offset-2 hover:underline">Sign out</button>
        </form>
      </main>
    </div>
  );
}
