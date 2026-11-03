import { userProfiles } from "@researchmate/database";
import { eq } from "drizzle-orm";
import { ActionForm, Field } from "@/components/action-form";
import { listScheduledDeletions } from "@researchmate/tenancy";
import { PageHeader, Section } from "@/components/ui";
import { deleteAccountAction, restoreOrganizationAction } from "@/server/actions/retention";
import { updateProfileAction } from "@/server/actions/account";
import { db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const session = await requireSession();
  const [[p], scheduled] = await Promise.all([db().select().from(userProfiles).where(eq(userProfiles.userId, session.user.id)), listScheduledDeletions(db(), session.user.id)]);
  return (
    <>
      <PageHeader title="Profile" description="How you appear to collaborators and supervisors. Institution details pre-fill new projects later." />
      <div className="max-w-xl">
        <ActionForm action={updateProfileAction} submitLabel="Save profile" pendingLabel="Saving…">
          <Field label="Name" name="displayName" required maxLength={100} defaultValue={p?.displayName} autoComplete="name" />
          <Field label="Email" name="email" type="email" defaultValue={session.user.email} disabled hint="Email changes aren't available yet." />
          <Field label="Institution" name="institution" maxLength={200} defaultValue={p?.institution} autoComplete="organization" />
          <Field label="Department" name="department" maxLength={200} defaultValue={p?.department} />
          <Field label="Discipline" name="discipline" maxLength={150} defaultValue={p?.discipline} />
          <Field label="Academic level" name="academicLevel" maxLength={100} defaultValue={p?.academicLevel} placeholder="e.g. Master's student" />
        </ActionForm>
      </div>

      {scheduled.length > 0 && (
        <Section title="Workspaces scheduled for deletion" description="Restore one before its deletion date to keep everything in it.">
          <ul className="grid max-w-xl gap-2">
            {scheduled.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-sheet px-4 py-3 text-sm">
                <span>
                  <strong>{o.name}</strong> — permanently deleted on {o.purgeAfter?.toISOString().slice(0, 10)}
                </span>
                <ActionForm action={restoreOrganizationAction} submitLabel={`Restore ${o.name}`} variant="quiet" className="flex">
                  <input type="hidden" name="organizationId" value={o.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Delete account" description="Ends your memberships and removes your sign-in details, keys and connections. Workspaces you own alone are scheduled for deletion and permanently deleted after 30 days. This can’t be undone. Records you created in shared projects stay, attributed to “Deleted user”.">
        <div className="max-w-xl">
          <ActionForm action={deleteAccountAction} submitLabel="Delete my account" variant="danger">
            <Field label="Password" name="password" type="password" autoComplete="current-password" required />
            <Field label="Authentication or recovery code (if two-factor is on)" name="code" autoComplete="one-time-code" maxLength={16} />
            <Field label="Type DELETE to confirm" name="confirm" required pattern="DELETE" autoComplete="off" />
          </ActionForm>
        </div>
      </Section>
    </>
  );
}
