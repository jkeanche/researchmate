import { formatBytes, getLimitStatus } from "@researchmate/entitlements";
import { listMembers } from "@researchmate/tenancy";
import { FEATURES, roles } from "@researchmate/database";
import { inArray } from "drizzle-orm";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { ConfirmAction } from "@/components/client-bits";
import { Meter, PageHeader, Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { deleteOrganizationAction } from "@/server/actions/retention";
import { addMemberAction, changeMemberRoleAction, removeMemberAction } from "@/server/actions/workspace";
import { db } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Organization" };

const ORG_ROLES = ["org_owner", "org_admin", "org_researcher", "org_finance_manager", "org_member", "org_viewer"];

export default async function OrganizationPage() {
  const { session, org } = await requireWorkspace();
  const [status, members, roleRows] = await Promise.all([
    getLimitStatus(db(), org.organizationId),
    listMembers(db(), session.user.id, org.organizationId),
    db().select().from(roles).where(inArray(roles.key, ORG_ROLES)),
  ]);
  const roleName = Object.fromEntries(roleRows.map((r) => [r.key, r.name]));
  const assignable = roleRows.filter((r) => r.key !== "org_owner").sort((a, b) => b.rank - a.rank);
  const canManage = org.permissions.has("org.members.manage");
  const lim = Object.fromEntries(status.limits.map((l) => [l.key, l]));
  const ent = status.entitlements;

  const included = (Object.keys(FEATURES) as (keyof typeof FEATURES)[])
    .filter((k) => FEATURES[k].kind !== "limit")
    .map((k) => {
      const def = FEATURES[k] as { kind: string; description: string; tiers?: readonly string[] };
      const v = ent.values[k];
      const on = def.kind === "flag" ? v === true : v !== def.tiers?.[0];
      const label = def.kind === "tier" && on ? String(v).replace(/^\w/, (c) => c.toUpperCase()) : on ? "Included" : "Not included";
      return { key: k, description: def.description, on, label };
    });

  return (
    <>
      <PageHeader
        title={org.organizationName}
        description={<>{org.organizationKind === "personal" ? "Your personal workspace." : "Team organization."} You are {roleName[org.roleKey] ?? org.roleKey}.</>}
        actions={<Link href="/app/organizations/new" className="btn btn-quiet">New organization</Link>}
      />

      <Section title={`${ent.planName} plan`} description="Usage counts every project (including archived ones) and every stored version of every file.">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Meter label="Projects" used={lim["projects.max"]!.used} limit={lim["projects.max"]!.limit} format={String} />
          <Meter label="Members" used={lim["members.max"]!.used} limit={lim["members.max"]!.limit} format={String} />
          <Meter label="Files" used={lim["files.max"]!.used} limit={lim["files.max"]!.limit} format={String} />
          <Meter label="Storage" used={lim["storage.max_bytes"]!.used} limit={lim["storage.max_bytes"]!.limit} format={formatBytes} />
        </div>
        <p className="mt-4 text-sm text-graphite">
          Largest file: {lim["files.max_size_bytes"]!.limit === null ? "no plan limit" : formatBytes(lim["files.max_size_bytes"]!.limit!)}.
          {" "}If you go over a limit after changing plan, nothing is deleted; you just can't add more until you're back under it.
        </p>
        <details className="mt-6 max-w-2xl">
          <summary className="cursor-pointer text-sm font-medium">What's included</summary>
          <ul className="ruled mt-3 text-sm">
            {included.map((f) => (
              <li key={f.key} className="flex justify-between gap-4 py-2">
                <span>{f.description}</span>
                <span className={f.on ? "text-green-dark" : "text-graphite"}>{f.label}</span>
              </li>
            ))}
          </ul>
        </details>
        {org.permissions.has("org.billing.manage") && (
          <p className="mt-6 max-w-2xl text-sm text-graphite">
            Online checkout arrives with billing. To change plan now, contact the platform team and we'll update your subscription.
          </p>
        )}
      </Section>

      <Section title="Members">
        <ul className="ruled mb-8">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">{m.displayName ?? m.email}{m.userId === session.user.id ? " (you)" : ""}</p>
                <p className="text-graphite">{m.email}, joined {formatDate(m.joinedAt)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canManage && m.roleKey !== "org_owner" && m.userId !== session.user.id ? (
                  <>
                    <ActionForm action={changeMemberRoleAction} submitLabel="Change" variant="quiet" className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={m.userId} />
                      <label className="sr-only" htmlFor={`role-${m.userId}`}>Role</label>
                      <select id={`role-${m.userId}`} name="roleKey" defaultValue={m.roleKey} className="input py-1.5">
                        {assignable.map((r) => (
                          <option key={r.key} value={r.key}>{r.name}</option>
                        ))}
                      </select>
                    </ActionForm>
                    <ConfirmAction action={removeMemberAction} fields={{ userId: m.userId }} label="Remove" confirmText={`Remove ${m.email} from ${org.organizationName}?`} />
                  </>
                ) : (
                  <span className="rounded border border-rule px-2 py-0.5">{roleName[m.roleKey] ?? m.roleKey}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        {canManage && lim["members.max"]!.limit !== null && lim["members.max"]!.used >= lim["members.max"]!.limit! ? (
          <p className="max-w-xl text-sm text-graphite">
            The {ent.planName} plan allows {lim["members.max"]!.limit} member{lim["members.max"]!.limit === 1 ? "" : "s"}. Upgrade to add collaborators.
          </p>
        ) : canManage && (
          <div className="max-w-xl">
            <h3 className="mb-3 text-base">Add a member</h3>
            <ActionForm action={addMemberAction} submitLabel="Add member" pendingLabel="Adding…" resetOnSuccess>
              <Field label="Email" name="email" type="email" required hint="They need a verified ResearchMate account. Email invitations are coming with collaboration features." />
              <div className="field">
                <label htmlFor="f-roleKey">Role</label>
                <select id="f-roleKey" name="roleKey" className="input" defaultValue="org_researcher">
                  {assignable.map((r) => (
                    <option key={r.key} value={r.key}>{r.name}: {r.description}</option>
                  ))}
                </select>
              </div>
            </ActionForm>
          </div>
        )}
      </Section>
      {org.roleKey === "org_owner" && (
        <Section title="Delete this workspace" description={`Everyone loses access immediately. Projects, files, documents and notes are permanently deleted after 30 days; until then you can restore it from Settings → Profile. Invoices and payment records are kept for accounting.`}>
          <div className="max-w-xl">
            <ActionForm action={deleteOrganizationAction} submitLabel="Delete workspace" variant="danger">
              <Field label={`Type the workspace name (${org.organizationName}) to confirm`} name="confirmName" required autoComplete="off" />
              <Field label="Password" name="password" type="password" autoComplete="current-password" required />
              <Field label="Authentication or recovery code (if two-factor is on)" name="code" autoComplete="one-time-code" maxLength={16} />
            </ActionForm>
          </div>
        </Section>
      )}
    </>
  );
}
