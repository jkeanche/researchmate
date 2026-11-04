import { CATEGORY_LABELS } from "@researchmate/admin";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { helpAction } from "@/server/actions/support";
import { supportService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Help" };

const STATUS: Record<string, [string, string]> = { open: ["We're on it", "open"], pending: ["Waiting for you", "awaiting_approval"], resolved: ["Resolved", "done"], closed: ["Closed", "closed"] };

export default async function HelpPage() {
  const { session, org } = await requireWorkspace();
  const tickets = await supportService().listForUser(session.user.id);
  return (
    <>
      <PageHeader title="Help" description={<>Ask us anything about ResearchMate. We reply by email and here. Your message includes which workspace you&rsquo;re in ({org.organizationName}) so we can look into it.</>} />
      <Section title="Your enquiries">
        {tickets.length === 0 ? (
          <p className="text-sm text-graphite">You haven&rsquo;t contacted us yet.</p>
        ) : (
          <ul className="grid gap-2">
            {tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule bg-sheet px-4 py-2 text-sm">
                <Link href={`/app/help/${t.id}`} className="font-medium">{t.subject}</Link>
                <span className="flex items-center gap-2 text-graphite">
                  <span className="font-mono text-xs">{t.reference}</span>
                  <Tag tone={STATUS[t.status]?.[1] ?? t.status}>{STATUS[t.status]?.[0] ?? t.status}</Tag>
                  {formatDateTime(t.lastMessageAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="New enquiry">
        <ActionForm action={helpAction} submitLabel="Send" pendingLabel="Sending…" className="grid max-w-2xl gap-4">
          <div className="field">
            <label htmlFor="h-cat">Topic</label>
            <select id="h-cat" name="category" className="input" defaultValue="technical">
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <Field label="Subject" name="subject" required minLength={3} maxLength={150} />
          <div className="field">
            <label htmlFor="h-body">Message</label>
            <textarea id="h-body" name="body" className="input min-h-36" required minLength={10} maxLength={10000} />
            <span className="hint">Say what you were doing and what happened. Please don&rsquo;t include passwords.</span>
          </div>
        </ActionForm>
      </Section>
    </>
  );
}
