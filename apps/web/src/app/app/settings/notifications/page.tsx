import { getPreferences } from "@researchmate/tenancy";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { savePreferencesAction } from "@/server/actions/notifications";
import { db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const s = await requireSession();
  const prefs = await getPreferences(db(), s.user.id);
  const groups = [...new Set(prefs.map((p) => p.group))];
  return (
    <>
      <PageHeader title="Notification settings" description="Choose which notices appear in ResearchMate and which are also emailed. Security notices are always emailed so a stolen session can't hide them." />
      <ActionForm action={savePreferencesAction} submitLabel="Save settings" className="grid max-w-3xl gap-6">
        {groups.map((g) => (
          <fieldset key={g} className="rounded-md border border-rule bg-sheet p-4">
            <legend className="px-1 font-semibold">{g}</legend>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-graphite">
                  <th scope="col" className="py-1 font-normal">Notice</th>
                  <th scope="col" className="w-20 py-1 text-center font-normal">In app</th>
                  <th scope="col" className="w-20 py-1 text-center font-normal">Email</th>
                </tr>
              </thead>
              <tbody>
                {prefs.filter((p) => p.group === g).map((p) => (
                  <tr key={p.kind} className="border-t border-rule-soft">
                    <td className="py-2 pr-3" id={`lbl-${p.kind}`}>{p.label}</td>
                    <td className="text-center">
                      <input type="checkbox" name={`${p.kind}:inApp`} defaultChecked={p.inApp} aria-label={`${p.label}: in app`} />
                    </td>
                    <td className="text-center">
                      <input type="checkbox" name={`${p.kind}:email`} defaultChecked={p.email} disabled={p.locked} aria-label={`${p.label}: email${p.locked ? " (always on)" : ""}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </fieldset>
        ))}
      </ActionForm>
    </>
  );
}
