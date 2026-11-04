import { STATUS_LABEL, TICKET_TONE } from "./admin-ui";
import { Tag } from "./plan-ui";
import { formatDateTime } from "@/lib/format";

const REQUESTER_STATUS: Record<string, string> = { open: "We're on it", pending: "Waiting for you", resolved: "Resolved", closed: "Closed" };

/** The requester's view of an enquiry (internal notes are never passed in). */
export function Conversation({ ticket, messages }: { ticket: { status: string; createdAt: Date }; messages: { id: string; authorType: string; authorName: string; body: string; createdAt: Date }[] }) {
  return (
    <>
      <p className="mt-2 mb-6 flex items-center gap-2 text-sm text-graphite">
        <Tag tone={TICKET_TONE[ticket.status] ?? ticket.status}>{REQUESTER_STATUS[ticket.status] ?? STATUS_LABEL[ticket.status] ?? ticket.status}</Tag> opened {formatDateTime(ticket.createdAt)}
      </p>
      <ol className="grid gap-3">
        {messages.map((m) => (
          <li key={m.id} className={`rounded-md border px-4 py-3 ${m.authorType === "staff" ? "border-green/30 bg-green-wash" : "border-rule bg-sheet"}`}>
            <p className="mb-1 flex flex-wrap justify-between gap-2 text-xs text-graphite">
              <span className="font-semibold text-ink">{m.authorType === "staff" ? m.authorName : "You"}</span>
              <span>{formatDateTime(m.createdAt)}</span>
            </p>
            <p className="text-sm whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>
    </>
  );
}
