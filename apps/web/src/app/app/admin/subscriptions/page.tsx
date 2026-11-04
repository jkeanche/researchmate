import type { SubscriptionFilter } from "@researchmate/admin";
import Link from "next/link";
import { Pager, Select, STATUS_LABEL, SUB_TONE, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { adminService, planAdminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Subscriptions · Administration" };

const FILTERS = [
  ["live", "Current (all)"],
  ["paid", "Paid online"],
  ["complimentary", "Assigned by an administrator"],
  ["expiring", "Ending within 14 days"],
  ["past_due", "Past due"],
  ["ended", "Ended"],
  ["all", "Everything"],
] as const;

export default async function AdminSubscriptionsPage({ searchParams }: { searchParams: Promise<{ filter?: string; plan?: string; page?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const filter = (FILTERS.find(([v]) => v === sp.filter)?.[0] ?? "live") as SubscriptionFilter;
  const [r, plans] = await Promise.all([adminService().listSubscriptions(s.user.id, { filter, planId: sp.plan || undefined, page: Number(sp.page) || 1 }), planAdminService().list(s.user.id)]);
  return (
    <>
      <PageHeader title="Subscriptions" description="Which organization is on which plan, until when, and how it was paid. To change one, open its organization." />
      <form action="/app/admin/subscriptions" method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <Select id="sf" name="filter" label="Show" value={filter} options={FILTERS} />
        <Select id="sp" name="plan" label="Plan" value={sp.plan ?? ""} options={[["", "Any plan"], ...plans.map((p) => [p.plan.id, p.plan.name] as const)]} />
        <button className="btn btn-quiet" type="submit">Apply</button>
      </form>
      <Table head={["Organization", "Plan", "Status", "Period", "Source", "Updated"]} empty="Nothing matches.">
        {r.rows.map(({ s: x, plan, org, orgId, ownerEmail }) => (
          <tr key={x.id}>
            <td><Link href={`/app/admin/organizations/${orgId}`} className="font-medium">{org}</Link><span className="block text-xs text-graphite">{ownerEmail}</span></td>
            <td>{plan}</td>
            <td className="whitespace-nowrap"><Tag tone={SUB_TONE[x.status] ?? x.status}>{STATUS_LABEL[x.status] ?? x.status}</Tag>{x.cancelAtPeriodEnd && <span className="block text-xs text-graphite">won't renew</span>}</td>
            <td className="whitespace-nowrap">{formatDate(x.currentPeriodStart)} – {x.currentPeriodEnd ? formatDate(x.currentPeriodEnd) : "no end"}</td>
            <td>{x.provider === "manual" ? "administrator / default" : x.provider}</td>
            <td className="whitespace-nowrap">{formatDate(x.updatedAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager base="/app/admin/subscriptions" params={{ filter, plan: sp.plan }} page={r.page} total={r.total} />
    </>
  );
}
