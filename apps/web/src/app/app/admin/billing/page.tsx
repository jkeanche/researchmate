import { customerPrice, formatMoney, formatUsd } from "@researchmate/billing";
import { notFound } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { adminBillingAction } from "@/server/actions/billing";
import { paymentService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Billing administration" };

const EXAMPLE = `[
  { "kind": "ai_model", "providerKey": "openai", "modelId": "<model id>", "inputCostMicrosPerMTok": 0, "outputCostMicrosPerMTok": 0 },
  { "kind": "service", "serviceKey": "ocr.pages", "unit": "page", "unitCostMicros": 0 }
]`;

export default async function AdminBillingPage() {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const svc = paymentService();
  const [versions, list] = await Promise.all([svc.ledger.listPricing(), svc.adminPayments()]);
  return (
    <>
      <PageHeader title="Billing administration" description="Pricing versions and payments. Platform administrators only." />

      <Section title="Pricing versions" description="Enter provider costs from the providers' current price lists (micro-USD per million tokens, or per unit). Customer price = cost ÷ (1 − margin). Active versions can't be edited; activate a new version to change prices. Past charges keep the version they used.">
        <ul className="mb-6 grid gap-3">
          {versions.map(({ version: v, items }) => (
            <li key={v.id} className="rounded-md border border-rule bg-sheet p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">Version {v.version} · margin {(v.targetMarginBps / 100).toFixed(2)}% <span className="font-normal text-graphite">· {v.notes}</span></p>
                <span className="flex items-center gap-2">
                  <Tag tone={v.status === "active" ? "done" : v.status === "draft" ? "awaiting_approval" : "skipped"}>{v.status}</Tag>
                  {v.status === "draft" && (
                    <ActionForm action={adminBillingAction} submitLabel="Activate" variant="quiet" className="flex">
                      <input type="hidden" name="intent" value="activate_pricing" />
                      <input type="hidden" name="versionId" value={v.id} />
                    </ActionForm>
                  )}
                </span>
              </div>
              {items.length > 0 && (
                <table className="mt-2 w-full border-collapse text-xs">
                  <thead><tr className="border-b border-rule"><th scope="col" className="py-1 text-left">Item</th><th scope="col" className="py-1 text-right">Cost</th><th scope="col" className="py-1 text-right">Customer price</th></tr></thead>
                  <tbody>
                    {items.map((i) => {
                      const m = i.marginBpsOverride ?? v.targetMarginBps;
                      return (
                        <tr key={i.id} className="border-b border-rule-soft">
                          <td className="py-1">{i.kind === "ai_model" ? `${i.providerKey} · ${i.modelId}` : `${i.serviceKey} (per ${i.unit})`}</td>
                          <td className="py-1 text-right tabular-nums">{i.kind === "ai_model" ? `${formatUsd(i.inputCostMicrosPerMTok!)} / ${formatUsd(i.outputCostMicrosPerMTok!)} per M` : formatUsd(i.unitCostMicros!)}</td>
                          <td className="py-1 text-right tabular-nums">{i.kind === "ai_model" ? `${formatUsd(customerPrice(i.inputCostMicrosPerMTok!, m))} / ${formatUsd(customerPrice(i.outputCostMicrosPerMTok!, m))}` : formatUsd(customerPrice(i.unitCostMicros!, m))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
        <ActionForm action={adminBillingAction} submitLabel="Create draft" className="grid max-w-3xl gap-3">
          <input type="hidden" name="intent" value="draft_pricing" />
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field id="pv-margin" label="Target margin (%)" name="marginPercent" type="number" min={0} max={94.99} step={0.01} required defaultValue={40} />
            <Field id="pv-notes" label="Notes (sources of the costs)" name="notes" maxLength={1000} />
          </div>
          <div className="field">
            <label htmlFor="pv-items">Price lines (JSON)</label>
            <textarea id="pv-items" name="items" className="input min-h-40 font-mono text-xs" defaultValue={EXAMPLE} />
          </div>
        </ActionForm>
      </Section>

      <Section title="Recent payments">
        <ul className="grid gap-2 text-sm">
          {list.map(({ p, org }) => (
            <li key={p.id} className="rounded-md border border-rule bg-sheet px-4 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{formatDateTime(p.createdAt)} · {org} · {p.kind} · {formatMoney(p.amountMinor, p.currency)} · {p.provider} · <code className="text-xs">{p.reference}</code></span>
                <span className="flex items-center gap-2">
                  <Tag tone={p.status === "succeeded" ? "done" : p.status === "pending" ? "awaiting_approval" : "skipped"}>{p.status}{p.refundedMinor ? ` (−${formatMoney(p.refundedMinor, p.currency)})` : ""}</Tag>
                  <ActionForm action={adminBillingAction} submitLabel="Check with provider" variant="quiet" className="flex">
                    <input type="hidden" name="intent" value="reconcile" />
                    <input type="hidden" name="paymentId" value={p.id} />
                  </ActionForm>
                </span>
              </div>
              {(p.status === "succeeded" || p.status === "partially_refunded") && (
                <ActionForm action={adminBillingAction} submitLabel="Refund" variant="danger" className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="intent" value="refund" />
                  <input type="hidden" name="paymentId" value={p.id} />
                  <Field id={`rf-a-${p.id}`} label={`Amount (${p.currency})`} name="amount" type="number" min={0.01} step={0.01} max={(p.amountMinor - p.refundedMinor) / 100} required />
                  <Field id={`rf-r-${p.id}`} label="Reason" name="reason" required maxLength={500} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
