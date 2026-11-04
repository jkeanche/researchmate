import Link from "next/link";
import { Pager, Select, Table } from "@/components/admin-ui";
import { PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { adminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Audit log · Administration" };

function summary(m: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined || k === "changes" || k === "changed") continue;
    parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  const changes = (m.changes ?? m.changed) as Record<string, { from: unknown; to: unknown }> | undefined;
  if (changes) for (const [k, c] of Object.entries(changes)) parts.push(`${k}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  return parts.join(" · ").slice(0, 400);
}

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ action?: string; actor?: string; org?: string; scope?: string; page?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const org = sp.org && /^[0-9a-f-]{36}$/.test(sp.org) ? sp.org : undefined;
  const r = await adminService().listAudit(s.user.id, { action: sp.action, actor: sp.actor, organizationId: org, adminOnly: sp.scope === "admin", page: Number(sp.page) || 1 });
  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of significant actions across the platform: administrator changes, membership and permission changes, billing, deletions and more. It never contains passwords, keys or file contents." />
      <form action="/app/admin/audit" method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <Select id="as" name="scope" label="Show" value={sp.scope ?? ""} options={[["", "Everything"], ["admin", "Administrator actions only"]]} />
        <div className="field"><label htmlFor="aa">Action starts with</label><input id="aa" name="action" className="input" defaultValue={sp.action} placeholder="admin.subscription" /></div>
        <div className="field"><label htmlFor="au">By (email)</label><input id="au" name="actor" className="input" defaultValue={sp.actor} /></div>
        {org && <input type="hidden" name="org" value={org} />}
        <button className="btn btn-quiet" type="submit">Apply</button>
        {org && <Link href="/app/admin/audit" className="text-sm">Clear organization filter</Link>}
      </form>
      <Table head={["When", "Action", "By", "Organization", "Details"]} empty="Nothing recorded.">
        {r.rows.map(({ a, actorEmail, org: orgName }) => (
          <tr key={a.id}>
            <td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
            <td className="font-mono text-xs">{a.action}</td>
            <td className="text-xs">{a.actorUserId ? <Link href={`/app/admin/users/${a.actorUserId}`}>{actorEmail ?? "deleted user"}</Link> : "system"}</td>
            <td className="text-xs">{a.organizationId ? <Link href={`/app/admin/organizations/${a.organizationId}`}>{orgName ?? "deleted"}</Link> : "—"}</td>
            <td className="max-w-md text-xs break-words text-graphite">
              {a.targetType === "user" && a.targetId ? <Link href={`/app/admin/users/${a.targetId}`}>user</Link> : a.targetType ? `${a.targetType}` : ""}{a.targetType ? " · " : ""}
              {summary(a.metadata)}
            </td>
          </tr>
        ))}
      </Table>
      <Pager base="/app/admin/audit" params={{ action: sp.action, actor: sp.actor, org, scope: sp.scope }} page={r.page} total={r.total} />
    </>
  );
}
