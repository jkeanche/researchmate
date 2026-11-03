import { userProfiles } from "@researchmate/database";
import { formatBytes, getLimitStatus } from "@researchmate/entitlements";
import { RESEARCH_TYPE_LABELS } from "@researchmate/research";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, Meter, PageHeader, ProgressRule, Section, StatusTag } from "@/components/ui";
import { daysUntil, formatDate } from "@/lib/format";
import { ActionForm } from "@/components/action-form";
import { collaborationAction } from "@/server/actions/collaboration";
import { authService, collaborationService, db, fileService, projectService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const { session, org } = await requireWorkspace();
  const userId = session.user.id;
  const [[profile], projects, deadlines, files, limits, tfa] = await Promise.all([
    db().select({ displayName: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, userId)),
    projectService().list(userId, org.organizationId),
    projectService().upcomingDeadlines(userId, org.organizationId),
    fileService().then((s) => s.list(userId, org.organizationId, { limit: 5 })),
    getLimitStatus(db(), org.organizationId),
    authService().getTwoFactorStatus(userId),
  ]);
  const collab = await collaborationService();
  const [invites, inbox] = await Promise.all([collab.pendingForUser(userId), collab.inbox(userId)]);

  const active = projects.filter((p) => p.status !== "archived");
  const lim = Object.fromEntries(limits.limits.map((l) => [l.key, l]));
  const overAny = limits.limits.some((l) => l.over);
  const canCreate = org.permissions.has("projects.create");

  const nextSteps: { text: string; href: string }[] = [];
  if (active.length === 0 && canCreate) nextSteps.push({ text: "Create your first research project", href: "/app/projects/new" });
  const noDates = active.find((p) => !p.expectedCompletionDate);
  if (noDates) nextSteps.push({ text: `Set an expected completion date for “${noDates.title}”`, href: `/app/projects/${noDates.id}` });
  if (files.length === 0 && org.permissions.has("files.upload")) nextSteps.push({ text: "Upload a reading or dataset", href: "/app/files" });
  if (!tfa.enabled) nextSteps.push({ text: "Protect your account with two-factor authentication", href: "/app/settings/security" });

  const firstName = profile?.displayName.split(" ")[0] ?? "";

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Dashboard"}
        description={<>{org.organizationName} is on the <strong className="text-ink">{limits.entitlements.planName}</strong> plan.</>}
        actions={canCreate ? <Link href="/app/projects/new" className="btn btn-primary">New project</Link> : null}
      />

      {overAny && (
        <p role="status" className="mb-8 rounded-md border border-amber/30 bg-amber-wash px-4 py-3 text-sm text-amber">
          This organization is above one of its plan limits. Everything stays readable and downloadable, but you can't add more until you're back within the limit or upgrade.
        </p>
      )}

      {invites.map((i) => (
        <div key={i.id} role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-green/30 bg-green-wash px-4 py-3 text-sm">
          <span>
            {i.invitedBy ?? "Someone"} invited you to {i.role === "project_supervisor" ? "supervise" : "join"} <strong>{i.projectTitle ?? i.organizationName}</strong> in {i.organizationName}.
          </span>
          <span className="flex gap-2">
            <ActionForm action={collaborationAction} submitLabel="Accept" className="flex">
              <input type="hidden" name="intent" value="accept_invitation" />
              <input type="hidden" name="invitationId" value={i.id} />
            </ActionForm>
            <ActionForm action={collaborationAction} submitLabel="Decline" variant="quiet" className="flex">
              <input type="hidden" name="intent" value="decline_invitation" />
              <input type="hidden" name="invitationId" value={i.id} />
            </ActionForm>
          </span>
        </div>
      ))}

      {inbox.length > 0 && (
        <Section title={`Waiting for your review (${inbox.length})`}>
          <ul className="ruled mb-2">
            {inbox.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span>
                  <Link href={`/app/projects/${r.project_id}/reviews/${r.id}`} className="font-semibold">{r.title}</Link>
                  <span className="text-graphite"> · {r.project_title} · round {r.round} · submitted {formatDate(r.created_at)}{r.due_date ? ` · wanted by ${formatDate(r.due_date)}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-x-12 lg:grid-cols-[1fr_17rem]">
        <div className="min-w-0">
          <Section title="Active projects" aside={<Link href="/app/projects" className="text-sm text-green">All projects</Link>}>
            {active.length === 0 ? (
              <EmptyState
                title="No active projects"
                body="A project holds your research questions, sources, files and schedule. Start with a title and research type; you can fill in the rest later."
                action={canCreate ? { href: "/app/projects/new", label: "Create a project" } : undefined}
              />
            ) : (
              <ul className="ruled">
                {active.slice(0, 6).map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
                    <div className="min-w-0">
                      <Link href={`/app/projects/${p.id}`} className="font-semibold no-underline hover:underline">{p.title}</Link>
                      <p className="text-sm text-graphite">
                        {RESEARCH_TYPE_LABELS[p.researchType as keyof typeof RESEARCH_TYPE_LABELS]} <StatusTag status={p.status} />
                      </p>
                    </div>
                    <ProgressRule value={p.progressPercent} label="Progress" />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Upcoming deadlines">
            {deadlines.length === 0 ? (
              <p className="text-sm text-graphite">No deadlines in the next four months. Add expected completion dates to your projects to see them here.</p>
            ) : (
              <ul className="ruled">
                {deadlines.map((d) => {
                  const days = daysUntil(d.expectedCompletionDate!);
                  return (
                    <li key={d.id} className="flex items-baseline justify-between gap-4 py-2.5">
                      <Link href={`/app/projects/${d.id}`} className="no-underline hover:underline">{d.title}</Link>
                      <span className={`text-sm tabular-nums ${d.overdue ? "font-semibold text-margin" : "text-graphite"}`}>
                        {formatDate(d.expectedCompletionDate)}, {d.overdue ? `${-days} days overdue` : days === 0 ? "today" : `in ${days} days`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Recent files" aside={<Link href="/app/files" className="text-sm text-green">All files</Link>}>
            {files.length === 0 ? (
              <p className="text-sm text-graphite">Nothing uploaded yet.</p>
            ) : (
              <ul className="ruled">
                {files.map((f) => (
                  <li key={f.id} className="flex items-baseline justify-between gap-4 py-2.5">
                    <a href={`/api/files/${f.id}/download`} className="truncate no-underline hover:underline">{f.originalName}</a>
                    <span className="shrink-0 text-sm text-graphite">{formatBytes(f.sizeBytes)}, {formatDate(f.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside className="min-w-0">
          {nextSteps.length > 0 && (
            <Section title="Next steps">
              <ul className="grid gap-2 text-sm">
                {nextSteps.slice(0, 4).map((s) => (
                  <li key={s.text}>
                    <Link href={s.href} className="text-green underline-offset-2 hover:underline">{s.text}</Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Plan usage" aside={<Link href="/app/settings/organization" className="text-sm text-green">Details</Link>}>
            <div className="grid gap-4">
              <Meter label="Projects" used={lim["projects.max"]!.used} limit={lim["projects.max"]!.limit} format={String} />
              <Meter label="Files" used={lim["files.max"]!.used} limit={lim["files.max"]!.limit} format={String} />
              <Meter label="Storage" used={lim["storage.max_bytes"]!.used} limit={lim["storage.max_bytes"]!.limit} format={formatBytes} />
            </div>
          </Section>
        </aside>
      </div>
    </>
  );
}
