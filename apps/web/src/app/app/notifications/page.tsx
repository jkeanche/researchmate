import { listNotifications } from "@researchmate/tenancy";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { markReadAction } from "@/server/actions/notifications";
import { db } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const s = await requireSession();
  const rows = await listNotifications(db(), s.user.id, { limit: 100 });
  const unread = rows.filter((r) => !r.readAt).length;
  return (
    <>
      <PageHeader
        title="Notifications"
        description={<>Deadlines, reviews, documents, budgets, billing and security. Choose what you receive in <Link href="/app/settings/notifications">notification settings</Link>.</>}
        actions={unread > 0 ? (
          <ActionForm action={markReadAction} submitLabel="Mark all as read" variant="quiet" className="flex">
            <input type="hidden" name="notificationId" value="" />
          </ActionForm>
        ) : undefined}
      />
      {rows.length === 0 ? (
        <EmptyState title="Nothing yet" body="Notices about your projects and account will appear here." />
      ) : (
        <ul className="grid gap-2">
          {rows.map((n) => (
            <li key={n.id} className={`rounded-md border p-4 text-sm ${n.readAt ? "border-rule bg-sheet" : "border-ink/30 bg-paper"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-3xl">
                  <p className="font-semibold">
                    {!n.readAt && <span className="sr-only">Unread: </span>}
                    {n.link ? <Link href={n.link}>{n.title}</Link> : n.title}
                  </p>
                  {n.body && <p className="mt-1 whitespace-pre-line text-graphite">{n.body}</p>}
                  <p className="mt-1 text-xs text-graphite">{n.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</p>
                </div>
                {!n.readAt && (
                  <ActionForm action={markReadAction} submitLabel="Mark read" variant="quiet" className="flex">
                    <input type="hidden" name="notificationId" value={n.id} />
                  </ActionForm>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
