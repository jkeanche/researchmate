import { CATEGORY_LABELS, type SupportStatus } from "@researchmate/admin";
import Link from "next/link";
import { FilterBar, Pager, Select, STATUS_LABEL, Table, TICKET_TONE } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { supportService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Enquiries · Administration" };

const STATUSES = [["active", "Needs handling (open + pending)"], ["open", "Waiting for us"], ["pending", "Waiting for requester"], ["resolved", "Resolved"], ["closed", "Closed"], ["all", "All"]] as const;

export default async function AdminEnquiriesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; category?: string; assigned?: string; page?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const status = (STATUSES.find(([v]) => v === sp.status)?.[0] ?? "active") as SupportStatus | "active" | "all";
  const assigned = sp.assigned === "me" || sp.assigned === "unassigned" ? sp.assigned : undefined;
  const svc = supportService();
  const [r, counts] = await Promise.all([svc.list(s.user.id, { q: sp.q, status, category: sp.category, assigned, page: Number(sp.page) || 1 }), svc.counts(s.user.id)]);
  return (
    <>
      <PageHeader
        title="Enquiries"
        description={<>Messages from the <Link href="/contact">contact form</Link> and from signed-in users&rsquo; Help page. Replies are emailed to the requester. {counts.open} waiting for us · {counts.unassigned} unassigned · {counts.mine} assigned to you.</>}
      />
      <FilterBar action="/app/admin/enquiries" q={sp.q} placeholder="Subject, name, email or RM-reference">
        <Select id="es" name="status" label="Status" value={status} options={STATUSES} />
        <Select id="ec" name="category" label="Topic" value={sp.category ?? ""} options={[["", "Any"], ...Object.entries(CATEGORY_LABELS)]} />
        <Select id="ea" name="assigned" label="Assigned" value={assigned ?? ""} options={[["", "Anyone"], ["me", "To me"], ["unassigned", "Unassigned"]]} />
      </FilterBar>
      <Table head={["Enquiry", "From", "Status", "Assigned", "Last message"]} empty="No enquiries match.">
        {r.rows.map(({ t, assignee, messages }) => (
          <tr key={t.id}>
            <td>
              <Link href={`/app/admin/enquiries/${t.id}`} className="font-medium">{t.subject}</Link>
              <span className="block text-xs text-graphite"><span className="font-mono">{t.reference}</span> · {CATEGORY_LABELS[t.category as keyof typeof CATEGORY_LABELS] ?? t.category} · {messages} message{messages === 1 ? "" : "s"}</span>
            </td>
            <td>{t.requesterName}<span className="block text-xs text-graphite">{t.requesterEmail}{t.userId ? " · has an account" : ""}</span></td>
            <td className="space-x-1 whitespace-nowrap">
              <Tag tone={TICKET_TONE[t.status] ?? t.status}>{STATUS_LABEL[t.status] ?? t.status}</Tag>
              {(t.priority === "high" || t.priority === "urgent") && <Tag tone="blocked">{t.priority}</Tag>}
            </td>
            <td className="text-xs">{assignee ?? "—"}</td>
            <td className="whitespace-nowrap">{formatDateTime(t.lastMessageAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager base="/app/admin/enquiries" params={{ q: sp.q, status, category: sp.category, assigned }} page={r.page} total={r.total} />
    </>
  );
}
