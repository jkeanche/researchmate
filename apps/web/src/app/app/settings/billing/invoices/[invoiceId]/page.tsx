import { formatMoney } from "@researchmate/billing";
import { env, isAppError } from "@researchmate/shared";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/client-bits";
import { formatDate } from "@/lib/format";
import { paymentService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  const { session } = await requireWorkspace();
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) notFound();
  let data;
  try {
    data = await paymentService().invoice(session.user.id, invoiceId);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { invoice: i, payment: p } = data;
  // Seller name, address and tax registration, as configured by the operator.
  const issuer = (env().INVOICE_ISSUER ?? "").split("|").map((l) => l.trim()).filter(Boolean);
  return (
    <article className="mx-auto max-w-2xl rounded-md border border-rule bg-white p-8 text-ink">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-serif text-2xl">ResearchMate</p>
          <p className="text-sm text-graphite">{i.kind === "credit_note" ? "Credit note" : "Invoice"} {i.number}</p>
        </div>
        <div className="no-print"><PrintButton /></div>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-graphite">Issued</dt>
        <dd>{formatDate(i.issuedAt)}</dd>
        <dt className="text-graphite">Billed to</dt>
        <dd>{i.billTo.organization}{i.billTo.email ? <><br />{i.billTo.email}</> : null}</dd>
        <dt className="text-graphite">Paid with</dt>
        <dd>{p.provider} · reference {p.reference}{typeof p.details.confirmationCode === "string" && p.details.confirmationCode ? ` · ${p.details.confirmationCode}` : ""}</dd>
      </dl>
      <table className="mt-6 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule"><th scope="col" className="py-2 text-left">Description</th><th scope="col" className="py-2 text-right">Amount</th></tr>
        </thead>
        <tbody>
          {i.lines.map((l, k) => (
            <tr key={k} className="border-b border-rule-soft"><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{formatMoney(l.amountMinor, i.currency)}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row" className="py-2 text-left">Total</th><td className="py-2 text-right font-semibold tabular-nums">{formatMoney(i.amountMinor, i.currency)}</td></tr>
        </tfoot>
      </table>
      <p className="mt-6 text-xs text-graphite">Issued electronically on confirmation of payment by the provider.</p>
      {issuer.length > 0 && <address className="mt-2 text-xs whitespace-pre-line text-graphite not-italic">{issuer.join("\n")}</address>}
    </article>
  );
}
