import Link from "next/link";
import { FilterBar, Pager, Select, STATUS_LABEL, SUB_TONE, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { adminService, planAdminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Organizations · Administration" };

export default async function AdminOrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; plan?: string; deleted?: string; page?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const kind = sp.kind === "team" || sp.kind === "personal" ? sp.kind : undefined;
  const [r, plans] = await Promise.all([
    adminService().listOrganizations(s.user.id, { q: sp.q, kind, planId: sp.plan || undefined, deleted: sp.deleted === "1", page: Number(sp.page) || 1 }),
    planAdminService().list(s.user.id),
  ]);
  return (
    <>
      <PageHeader title="Organizations" description="Every workspace: personal ones (one per researcher) and team ones. Open one to change its plan, grant features, adjust credit or restore it." />
      <FilterBar action="/app/admin/organizations" q={sp.q} placeholder="Name or owner's email">
        <Select id="ok" name="kind" label="Kind" value={kind ?? ""} options={[["", "All"], ["team", "Team"], ["personal", "Personal"]]} />
        <Select id="op" name="plan" label="Plan" value={sp.plan ?? ""} options={[["", "Any plan"], ...plans.map((p) => [p.plan.id, p.plan.name] as const)]} />
        <Select id="od" name="deleted" label="Deletion" value={sp.deleted ?? ""} options={[["", "Any"], ["1", "Scheduled for deletion"]]} />
      </FilterBar>
      <Table head={["Organization", "Owner", "Plan", "Members", "Projects", "Created"]} empty="No organizations match.">
        {r.rows.map((o) => (
          <tr key={o.id}>
            <td>
              <Link href={`/app/admin/organizations/${o.id}`} className="font-medium">{o.name}</Link>
              <span className="block text-xs text-graphite">{o.kind}{o.deletedAt ? " · scheduled for deletion" : ""}</span>
            </td>
            <td><Link href={`/app/admin/users/${o.ownerId}`} className="text-sm">{o.ownerEmail}</Link></td>
            <td className="whitespace-nowrap">
              {o.plan ?? "default"} {o.status && o.status !== "active" && <Tag tone={SUB_TONE[o.status] ?? o.status}>{STATUS_LABEL[o.status] ?? o.status}</Tag>}
              {o.periodEnd && <span className="block text-xs text-graphite">until {formatDate(o.periodEnd)}</span>}
            </td>
            <td className="tabular-nums">{o.members}</td>
            <td className="tabular-nums">{o.projects}</td>
            <td className="whitespace-nowrap">{formatDate(o.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager base="/app/admin/organizations" params={{ q: sp.q, kind, plan: sp.plan, deleted: sp.deleted }} page={r.page} total={r.total} />
    </>
  );
}
