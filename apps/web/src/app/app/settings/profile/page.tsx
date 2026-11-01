import { userProfiles } from "@researchmate/database";
import { eq } from "drizzle-orm";
import { ActionForm, Field } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { updateProfileAction } from "@/server/actions/account";
import { db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const session = await requireSession();
  const [p] = await db().select().from(userProfiles).where(eq(userProfiles.userId, session.user.id));
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
    </>
  );
}
