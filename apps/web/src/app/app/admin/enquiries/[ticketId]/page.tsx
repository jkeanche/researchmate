import { CATEGORY_LABELS } from "@researchmate/admin";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { KeyValue, Select, STATUS_LABEL, TICKET_TONE } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { adminAction } from "@/server/actions/admin";
import { adminService, supportService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Enquiry · Administration" };

const STYLE: Record<string, string> = {
  requester: "border-rule bg-sheet",
  staff: "border-green/30 bg-green-wash",
  note: "border-amber/30 bg-amber-wash",
};

export default async function AdminEnquiryPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const s = await requireSession();
  const { ticketId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) notFound();
  const d = await supportService().get(s.user.id, ticketId).catch(() => null);
  if (!d) notFound();
  const admins = await adminService().listAdmins(s.user.id);
  const t = d.ticket;

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/app/admin/enquiries">← Enquiries</Link></p>
      <PageHeader
        title={t.subject}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{t.reference}</span>
            <Tag tone={TICKET_TONE[t.status] ?? t.status}>{STATUS_LABEL[t.status] ?? t.status}</Tag>
            {t.priority !== "normal" && <Tag tone={t.priority === "low" ? "todo" : "blocked"}>{t.priority}</Tag>}
            · {CATEGORY_LABELS[t.category as keyof typeof CATEGORY_LABELS] ?? t.category}
          </span>
        }
      />

      <div className="grid gap-x-10 lg:grid-cols-[1fr_18rem]">
        <div>
          <Section title="Conversation">
            <ol className="grid gap-3">
              {d.messages.map((m) => (
                <li key={m.id} className={`rounded-md border px-4 py-3 ${STYLE[m.authorType] ?? ""}`}>
                  <p className="mb-1 flex flex-wrap justify-between gap-2 text-xs text-graphite">
                    <span className="font-semibold text-ink">{m.authorType === "note" ? `Internal note · ${m.authorName}` : m.authorName}</span>
                    <span>{formatDateTime(m.createdAt)}</span>
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Reply" description={`Emailed to ${t.requesterEmail}${t.userId ? " and shown under Help in their account" : " with their private link to reply"}.`}>
            <ActionForm action={adminAction} submitLabel="Send reply" className="grid gap-3" resetOnSuccess>
              <input type="hidden" name="intent" value="ticket.reply" />
              <input type="hidden" name="id" value={t.id} />
              <div className="field">
                <label htmlFor="rp-body">Message</label>
                <textarea id="rp-body" name="body" className="input min-h-36" required maxLength={10000} />
              </div>
              <Select id="rp-status" name="status" label="Then mark it" value="pending" options={[["pending", "Waiting for requester"], ["resolved", "Resolved"], ["open", "Still open (we'll follow up)"], ["closed", "Closed (no further replies)"]]} />
            </ActionForm>
          </Section>

          <Section title="Internal note" description="Visible to administrators only; never emailed.">
            <ActionForm action={adminAction} submitLabel="Add note" variant="quiet" className="grid gap-3" resetOnSuccess>
              <input type="hidden" name="intent" value="ticket.note" />
              <input type="hidden" name="id" value={t.id} />
              <div className="field">
                <label htmlFor="nt-body">Note</label>
                <textarea id="nt-body" name="body" className="input min-h-20" required maxLength={10000} />
              </div>
            </ActionForm>
          </Section>
        </div>

        <aside>
          <Section title="Requester">
            <KeyValue
              rows={[
                ["Name", t.requesterName],
                ["Email", <a key="e" href={`mailto:${t.requesterEmail}`}>{t.requesterEmail}</a>],
                ["Account", d.account ? <Link key="a" href={`/app/admin/users/${d.account.id}`}>{d.account.status === "active" ? "open account" : "disabled account"}</Link> : "none"],
                ["Workspace", d.organization ? <Link key="o" href={`/app/admin/organizations/${d.organization.id}`}>{d.organization.name}</Link> : "—"],
                ["Via", t.source === "in_app" ? "Help page" : "Contact form"],
                ["Opened", formatDateTime(t.createdAt)],
              ]}
            />
          </Section>
          <Section title="Handling">
            <ActionForm action={adminAction} submitLabel="Update" variant="quiet" className="grid gap-3">
              <input type="hidden" name="intent" value="ticket.update" />
              <input type="hidden" name="id" value={t.id} />
              <Select id="tu-status" name="status" label="Status" value={t.status} options={[["open", "Waiting for us"], ["pending", "Waiting for requester"], ["resolved", "Resolved"], ["closed", "Closed"]]} />
              <Select id="tu-pri" name="priority" label="Priority" value={t.priority} options={[["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]]} />
              <Select id="tu-cat" name="category" label="Topic" value={t.category} options={Object.entries(CATEGORY_LABELS)} />
              <Select id="tu-as" name="assignedToUserId" label="Assigned to" value={t.assignedToUserId ?? ""} options={[["", "Nobody"], ...admins.map((a) => [a.id, a.name ?? a.email] as const)]} />
            </ActionForm>
          </Section>
          {d.earlier.length > 0 && (
            <Section title="Earlier enquiries">
              <ul className="grid gap-1 text-sm">
                {d.earlier.map((e) => (
                  <li key={e.id}><Link href={`/app/admin/enquiries/${e.id}`}>{e.subject}</Link> <span className="text-xs text-graphite">{formatDate(e.createdAt)} · {STATUS_LABEL[e.status] ?? e.status}</span></li>
                ))}
              </ul>
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}
