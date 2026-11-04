import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Conversation } from "@/components/support-ui";
import { supportReplyAction } from "@/server/actions/support";
import { supportService } from "@/server/services";

export const metadata = { title: "Your enquiry", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** A guest's enquiry, reached through the private link we emailed them. */
export default async function GuestEnquiryPage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<{ t?: string }> }) {
  const [{ ticketId }, { t }] = await Promise.all([params, searchParams]);
  const view = await supportService().forGuest(ticketId, t ?? "").catch(() => null);
  if (!view) notFound();
  return (
    <>
      <p className="font-mono text-xs text-graphite">{view.ticket.reference}</p>
      <h1 className="text-[1.75rem]">{view.ticket.subject}</h1>
      <Conversation ticket={view.ticket} messages={view.messages} />
      {view.ticket.status === "closed" ? (
        <p className="mt-6 text-sm text-graphite">This enquiry is closed. If you need anything else, please <a href="/contact">send a new message</a>.</p>
      ) : (
        <ActionForm action={supportReplyAction} submitLabel="Send reply" className="mt-6 grid gap-3" resetOnSuccess>
          <input type="hidden" name="ticketId" value={view.ticket.id} />
          <input type="hidden" name="token" value={t} />
          <div className="field">
            <label htmlFor="g-body">Add a reply</label>
            <textarea id="g-body" name="body" className="input min-h-28" required maxLength={10000} />
          </div>
        </ActionForm>
      )}
      <p className="mt-8 text-xs text-graphite">Keep this page&rsquo;s address private: anyone with the link can read this conversation.</p>
    </>
  );
}
