import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, FormMessage } from "@/components/action-form";
import { Conversation } from "@/components/support-ui";
import { supportReplyAction } from "@/server/actions/support";
import { supportService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Enquiry · Help" };

export default async function HelpTicketPage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<{ sent?: string }> }) {
  const s = await requireSession();
  const [{ ticketId }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) notFound();
  const view = await supportService().forUser(s.user.id, ticketId).catch(() => null);
  if (!view) notFound();
  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-sm"><Link href="/app/help">← Help</Link></p>
      {sp.sent && <div className="mb-4"><FormMessage state={{ success: `Sent. Your reference is ${view.ticket.reference}; we'll reply by email and here.` }} /></div>}
      <p className="font-mono text-xs text-graphite">{view.ticket.reference}</p>
      <h1 className="text-[1.75rem]">{view.ticket.subject}</h1>
      <Conversation ticket={view.ticket} messages={view.messages} />
      {view.ticket.status === "closed" ? (
        <p className="mt-6 text-sm text-graphite">This enquiry is closed. <Link href="/app/help">Send a new one</Link> if you need anything else.</p>
      ) : (
        <ActionForm action={supportReplyAction} submitLabel="Send reply" className="mt-6 grid gap-3" resetOnSuccess>
          <input type="hidden" name="ticketId" value={view.ticket.id} />
          <div className="field">
            <label htmlFor="hr-body">Add a reply</label>
            <textarea id="hr-body" name="body" className="input min-h-28" required maxLength={10000} />
          </div>
        </ActionForm>
      )}
    </div>
  );
}
