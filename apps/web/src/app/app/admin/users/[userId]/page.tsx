import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminButton, KeyValue, STATUS_LABEL, Table, TICKET_TONE } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { describeUserAgent, formatDate, formatDateTime } from "@/lib/format";
import { adminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "User · Administration" };

export default async function AdminUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const s = await requireSession();
  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(userId)) notFound();
  const d = await adminService().getUser(s.user.id, userId).catch(() => null);
  if (!d) notFound();
  const { user: u, profile } = d;
  const self = u.id === s.user.id;
  const deleted = u.email.endsWith("@deleted.invalid");

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/app/admin/users">← Users</Link></p>
      <PageHeader
        title={profile?.displayName ?? u.email}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {u.email}
            <Tag tone={u.status === "active" ? "in_progress" : "blocked"}>{u.status === "active" ? "Active" : "Disabled"}</Tag>
            {!u.emailVerifiedAt && <Tag tone="awaiting_approval">email not verified</Tag>}
            {u.isPlatformAdmin && <Tag tone="done">platform administrator</Tag>}
            {deleted && <Tag tone="skipped">deleted by owner</Tag>}
          </span>
        }
      />

      <div className="grid gap-x-10 lg:grid-cols-[1fr_1fr]">
        <Section title="Account">
          <KeyValue
            rows={[
              ["Joined", formatDateTime(u.createdAt)],
              ["Last sign-in", u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "never"],
              ["Email verified", u.emailVerifiedAt ? formatDateTime(u.emailVerifiedAt) : "no"],
              ["Two-factor", d.twoFactorEnabledAt ? `on since ${formatDate(d.twoFactorEnabledAt)}` : "off"],
              ["Institution", [profile?.institution, profile?.department].filter(Boolean).join(", ") || "—"],
              ["Discipline / level", [profile?.discipline, profile?.academicLevel].filter(Boolean).join(" · ") || "—"],
              ["Time zone", profile?.timezone ?? "—"],
            ]}
          />
        </Section>

        <Section title="Workspaces">
          <Table head={["Organization", "Role", "Plan"]} empty="Not a member of any organization.">
            {d.memberships.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/app/admin/organizations/${m.id}`}>{m.name}</Link>
                  <span className="block text-xs text-graphite">{m.kind === "personal" ? "personal" : "team"}{m.deletedAt ? " · scheduled for deletion" : ""}</span>
                </td>
                <td>{m.isOwner ? "Owner" : m.role}</td>
                <td>{m.plan ?? "default"}</td>
              </tr>
            ))}
          </Table>
        </Section>
      </div>

      {!deleted && (
        <Section title="Actions" description="Every action is recorded in the audit log with your name.">
          <div className="grid gap-5">
            {!u.emailVerifiedAt && (
              <div>
                <p className="mb-1 text-sm text-graphite">Mark the email address as verified (e.g. their verification email isn't arriving).</p>
                <AdminButton intent="user.verify" id={u.id} label="Mark email verified" />
              </div>
            )}
            {u.status === "active" && (
              <div>
                <p className="mb-1 text-sm text-graphite">Email them a link to choose a new password. Their current password keeps working until they do.</p>
                <AdminButton intent="user.password_reset" id={u.id} label="Send password reset email" />
              </div>
            )}
            <div>
              <p className="mb-1 text-sm text-graphite">Sign them out on every device ({d.sessions.length} active session{d.sessions.length === 1 ? "" : "s"}).</p>
              <AdminButton intent="user.revoke_sessions" id={u.id} label="Sign out everywhere" />
            </div>
            {d.twoFactorEnabledAt && (
              <div>
                <p className="mb-1 text-sm text-graphite">Only after confirming who they are: turns off two-factor so they can sign in with their password and set it up again.</p>
                <AdminButton intent="user.reset_2fa" id={u.id} label="Reset two-factor" variant="danger" reason="How you confirmed their identity" />
              </div>
            )}
            {/* Each toggle keeps one form mounted (only its intent changes) so its confirmation stays on screen after the page refreshes. */}
            {!self && (
              <div>
                <p className="mb-1 text-sm text-graphite">{u.status === "active" ? "Blocks sign-in and signs them out now. Their workspaces and data are kept." : "The account is disabled: they can't sign in."}</p>
                <AdminButton key="status" intent={u.status === "active" ? "user.disable" : "user.enable"} id={u.id} label={u.status === "active" ? "Disable account" : "Enable account"} variant={u.status === "active" ? "danger" : "primary"} reason="Reason" />
              </div>
            )}
            {!self && (u.isPlatformAdmin || (u.status === "active" && u.emailVerifiedAt)) && (
              <div>
                <p className="mb-1 text-sm text-graphite">{u.isPlatformAdmin ? "They can manage every user, plan, payment and enquiry." : "Administrators can manage every user, plan, payment and enquiry."}</p>
                <AdminButton key="admin" intent={u.isPlatformAdmin ? "user.revoke_admin" : "user.grant_admin"} id={u.id} label={u.isPlatformAdmin ? "Remove administrator role" : "Make platform administrator"} variant={u.isPlatformAdmin ? "danger" : "quiet"} reason="Reason" />
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="Active sessions">
        <Table head={["Device", "IP address", "Started", "Last seen"]} empty="No active sessions.">
          {d.sessions.map((x) => (
            <tr key={x.id}>
              <td>{describeUserAgent(x.userAgent)}</td>
              <td className="font-mono text-xs">{x.ipAddress ?? "—"}</td>
              <td className="whitespace-nowrap">{formatDateTime(x.createdAt)}</td>
              <td className="whitespace-nowrap">{formatDateTime(x.lastSeenAt)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      {d.tickets.length > 0 && (
        <Section title="Enquiries">
          <Table head={["Reference", "Subject", "Status", "Opened"]}>
            {d.tickets.map((t) => (
              <tr key={t.id}>
                <td><Link href={`/app/admin/enquiries/${t.id}`} className="font-mono text-xs">{t.reference}</Link></td>
                <td>{t.subject}</td>
                <td><Tag tone={TICKET_TONE[t.status] ?? t.status}>{STATUS_LABEL[t.status] ?? t.status}</Tag></td>
                <td className="whitespace-nowrap">{formatDate(t.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      <div className="grid gap-x-10 lg:grid-cols-2">
        <Section title="Security events">
          <ul className="grid gap-1 text-sm">
            {d.events.length === 0 && <li className="text-graphite">None recorded.</li>}
            {d.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-b border-rule-soft py-1">
                <span>{e.type.replace(/[._]/g, " ")}</span>
                <span className="whitespace-nowrap text-graphite">{formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Administrator actions on this account">
          <ul className="grid gap-1 text-sm">
            {d.audit.length === 0 && <li className="text-graphite">None.</li>}
            {d.audit.map(({ a, actorEmail }) => (
              <li key={a.id} className="border-b border-rule-soft py-1">
                <span className="font-mono text-xs">{a.action}</span> by {actorEmail ?? "system"}
                {typeof a.metadata.reason === "string" && <span className="text-graphite"> — {a.metadata.reason}</span>}
                <span className="block text-xs text-graphite">{formatDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
