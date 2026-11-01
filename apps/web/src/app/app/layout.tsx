import { userProfiles } from "@researchmate/database";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { OrgSwitcher } from "@/components/client-bits";
import { logoutAction } from "@/server/actions/auth";
import { switchOrganizationAction } from "@/server/actions/workspace";
import { db } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/projects", label: "Projects" },
  { href: "/app/files", label: "Files" },
  { href: "/app/settings/organization", label: "Organization" },
  { href: "/app/settings/profile", label: "Profile" },
  { href: "/app/settings/security", label: "Security" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, organizations, org } = await requireWorkspace();
  const [profile] = await db().select({ displayName: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, session.user.id));

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
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-2.5 py-1.5 text-[0.9375rem] whitespace-nowrap no-underline hover:bg-rule-soft">
              {n.label}
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
