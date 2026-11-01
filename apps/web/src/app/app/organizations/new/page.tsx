import { ActionForm, Field } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { createOrganizationAction } from "@/server/actions/workspace";

export const metadata = { title: "New organization" };

export default function NewOrganizationPage() {
  return (
    <>
      <PageHeader
        title="New organization"
        description="Organizations hold shared projects, members and a subscription, e.g. a research group, department or lab. You can own one organization on the Free plan."
      />
      <div className="max-w-md">
        <ActionForm action={createOrganizationAction} submitLabel="Create organization" pendingLabel="Creating…">
          <Field label="Organization name" name="name" required minLength={2} maxLength={80} placeholder="e.g. Agricultural Economics Research Group" />
        </ActionForm>
      </div>
    </>
  );
}
