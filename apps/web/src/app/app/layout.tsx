import { userProfiles } from "@researchmate/database";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { OrgSwitcher } from "@/components/client-bits";
import { logoutAction } from "@/server/actions/auth";
import { switchOrganizationAction } from "@/server/actions/workspace";
import { unreadCount } from "@researchmate/tenancy";
import { db, supportService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/projects", label: "Projects" },
  { href: "/app/search", label: "Search" },
  { href: "/app/files", label: "Files" },
  { href: "/app/notifications", label: "Notifications" },
  { href: "/app/settings/organization", label: "Organization" },
  { href: "/app/settings/profile", label: "Profile" },
  { href: "/app/settings/security", label: "Security" },
  { href: "/app/settings/ai", label: "AI keys" },
  { href: "/app/settings/billing", label: "Billing" },
  { href: "/app/settings/integrations", label: "Integrations" },
  { href: "/app/help", label: "Help" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, organizations, org } = await requireWorkspace();
  const [[profile], unread, enquiries] = await Promise.all([
    db().select({ displayName: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, session.user.id)),
    unreadCount(db(), session.user.id),
    session.user.isPlatformAdmin ? supportService().counts(session.user.id).then((c) => c.open).catch(() => 0) : Promise.resolve(0),
  ]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="border-b border-rule bg-sheet px-4 py-4 lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0 lg:px-5 lg:py-6">
        <div className="flex items-center justify-between lg:block">
          <Wordmark href="/app" />
          <form action={logoutAction} className="lg:hidden">
            <button className="text-sm text-graphite underline-offset-2 hover:underline">Sign out</button>
          </form>
        </div>
        <div className="mt-4 lg:mt-8">
          <OrgSwitcher current={org.organizationId} organizations={organizations} action={switchOrganizationAction} />
        </div>
        <nav aria-label="Main" className="mt-4 flex gap-1 overflow-x-auto pb-1 lg:mt-6 lg:grid lg:gap-0.5 lg:overflow-visible">
          {[...NAV, ...(session.user.isPlatformAdmin ? [{ href: "/app/admin", label: "Administration" }] : [])].map((n) => (
            <Link key={n.href} href={n.href} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[0.9375rem] whitespace-nowrap no-underline hover:bg-rule-soft">
              {n.label}
              {n.href === "/app/admin" && enquiries > 0 && (
                <span className="rounded-full bg-margin px-1.5 text-xs font-semibold text-paper tabular-nums" aria-label={`${enquiries} enquiries waiting`}>
                  {enquiries > 99 ? "99+" : enquiries}
                </span>
              )}
              {n.href === "/app/notifications" && unread > 0 && (
                <span className="rounded-full bg-margin px-1.5 text-xs font-semibold text-paper tabular-nums" aria-label={`${unread} unread`}>
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-10 hidden border-t border-rule-soft pt-4 text-sm lg:block">
          <p className="font-semibold">{profile?.displayName}</p>
          <p className="truncate text-graphite" title={session.user.email}>{session.user.email}</p>
          <form action={logoutAction} className="mt-3">
            <button className="text-graphite underline-offset-2 hover:underline">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="margin-rule min-w-0 px-6 py-8 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
