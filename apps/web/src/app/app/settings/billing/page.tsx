import { formatMoney, formatUsd } from "@researchmate/billing";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { Notice, Stat, Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { billingAction } from "@/server/actions/billing";
import { aiService, paymentService } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Billing" };

const PAY_STATUS: Record<string, [string, string]> = {
  pending: ["Waiting for payment", "awaiting_approval"],
  succeeded: ["Paid", "done"],
  failed: ["Failed", "blocked"],
  refunded: ["Refunded", "skipped"],
  partially_refunded: ["Partly refunded", "in_progress"],
  cancelled: ["Not completed", "skipped"],
};
const RETURN_MSG: Record<string, string> = {
  succeeded: "Payment confirmed with the provider. Thank you.",
  pending: "We haven't received confirmation from the payment provider yet. This page will show the payment once it's confirmed (mobile money can take a minute).",
  failed: "The payment didn't go through. You haven't been charged by ResearchMate.",
  cancelled: "Payment cancelled.",
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const { session, org } = await requireWorkspace();
  const sp = await searchParams;
  if (!org.permissions.has("org.billing.manage"))
    return (
      <>
        <PageHeader title="Billing" />
        <Notice>Only the organization owner manages billing.</Notice>
      </>
    );
  const svc = paymentService();
  const uid = session.user.id;
  const [sub, balance, usage, history, catalogue, platform] = await Promise.all([
    svc.subscription(org.organizationId),
    svc.ledger.balance(org.organizationId),
    svc.ledger.usageBreakdown(uid, org.organizationId),
    svc.history(uid, org.organizationId),
    svc.catalogue(),
    aiService().platformStatus(org.organizationId),
  ]);
  const providers = svc.available();
  const buyable = catalogue.filter((c) => providers.some((p) => p.currencies.includes(c.p.currency)));
  const hidden = null;
  const pct = balance.allowanceMicros ? Math.min(100, Math.round((balance.allowanceUsedMicros / balance.allowanceMicros) * 100)) : 0;

  return (
    <>
      <PageHeader title="Billing" description={<>Plan, AI credit, spending limits, usage and invoices for {org.organizationName}.</>} />
      {sp.payment && RETURN_MSG[sp.payment] && (
        <p role="status" className={`mb-6 rounded-md border px-4 py-3 text-sm ${sp.payment === "succeeded" ? "border-green/30 bg-green-wash text-green-dark" : sp.payment === "failed" ? "border-margin/30 bg-margin-wash text-margin" : "border-amber/30 bg-amber-wash text-amber"}`}>
          {RETURN_MSG[sp.payment]}
        </p>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-4">
        <Stat label="Plan" value={sub?.planName ?? "—"} note={sub?.s.currentPeriodEnd ? `${sub.s.cancelAtPeriodEnd ? "ends" : sub.s.status === "past_due" ? "renewal overdue since" : "paid until"} ${formatDate(sub.s.currentPeriodEnd)}` : "no paid period"} tone={sub?.s.status === "past_due" ? "warn" : undefined} />
        <Stat label="AI credit" value={formatUsd(balance.creditMicros)} note="prepaid, carries over" tone={balance.creditMicros < 0 ? "bad" : undefined} />
        <Stat label="Included this month" value={`${formatUsd(balance.allowanceRemainingMicros)}`} note={`${pct}% of ${formatUsd(balance.allowanceMicros)} used`} />
        <Stat label="Spent this month" value={formatUsd(balance.monthSpendMicros)} note={balance.monthlyCapMicros !== null ? `limit ${formatUsd(balance.monthlyCapMicros)}` : "no monthly limit"} />
      </div>

      <Section title="Platform AI" description="Use AI without your own provider key. Runs are charged at the published price (provider cost plus margin) to this month's included amount first, then to prepaid credit. Your own keys are never charged by ResearchMate.">
        {platform.available ? (
          <p className="text-sm">
            Model: <strong>{platform.model}</strong> · price version {platform.price.pricingVersionId.slice(0, 8)} · {formatUsd(Math.ceil((platform.price.item.inputCostMicrosPerMTok ?? 0) * 10_000 / (10_000 - platform.price.marginBps)))} per million input tokens, {formatUsd(Math.ceil((platform.price.item.outputCostMicrosPerMTok ?? 0) * 10_000 / (10_000 - platform.price.marginBps)))} per million output tokens.
          </p>
        ) : (
          <Notice>{platform.reason} You can still use AI with <Link href="/app/settings/ai">your own key</Link>.</Notice>
        )}
      </Section>

      <Section title="Buy" description="Payments are confirmed with the provider before anything is added. Mobile money and cards are supported where the provider offers them.">
        {providers.length === 0 ? (
          <Notice>Online payment isn't configured on this installation yet. Contact the administrator.</Notice>
        ) : buyable.length === 0 ? (
          <Notice>Nothing is on sale in a currency the configured payment providers accept.</Notice>
        ) : (
          <ActionForm action={billingAction} submitLabel="Continue to payment" className="grid max-w-2xl gap-4">
            {hidden}
            <input type="hidden" name="intent" value="buy" />
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">Item</legend>
              {buyable.map(({ p, planName }, i) => (
                <label key={p.id} className="flex items-center justify-between gap-3 rounded border border-rule bg-sheet px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <input type="radio" name="pricePointId" value={p.id} defaultChecked={i === 0} />
                    {p.kind === "plan" ? `${planName} plan — 1 ${p.interval}` : `AI credit ${formatUsd(p.creditMicros!)}`}
                  </span>
                  <span className="font-semibold tabular-nums">{formatMoney(p.amountMinor, p.currency)}</span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="b-provider">Pay with</label>
              <select id="b-provider" name="provider" className="input">
                {providers.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.methods}; {p.currencies.join(", ")})</option>)}
              </select>
            </div>
            <p className="text-xs text-graphite">Plans are prepaid for the period shown; renew any time and the new period is added to the end of the current one. Prices in each currency are set by ResearchMate, not converted automatically.</p>
          </ActionForm>
        )}
        {sub?.s.currentPeriodEnd && (
          <div className="mt-4">
            <ActionForm action={billingAction} submitLabel={sub.s.cancelAtPeriodEnd ? "Keep my plan" : "Don't renew"} variant="quiet" className="flex">
              <input type="hidden" name="intent" value={sub.s.cancelAtPeriodEnd ? "resume" : "cancel"} />
            </ActionForm>
            <p className="mt-1 text-xs text-graphite">When a plan ends, nothing is deleted. Anything above the free plan's limits stays readable and downloadable but becomes read-only.</p>
          </div>
        )}
      </Section>

      <Section title="Spending limits" description="Caps for platform-funded AI and services. Leave blank for no limit beyond your available credit.">
        <ActionForm action={billingAction} submitLabel="Save limits" className="grid max-w-xl gap-4 sm:grid-cols-2">
          <input type="hidden" name="intent" value="limits" />
          <Field id="l-month" label="Monthly limit (US$)" name="monthlyCap" type="number" min={0} step={0.01} defaultValue={balance.monthlyCapMicros !== null ? balance.monthlyCapMicros / 1e6 : ""} />
          <Field id="l-run" label="Per-run limit (US$)" name="perRunCap" type="number" min={0} step={0.01} defaultValue={balance.perRunCapMicros !== null ? balance.perRunCapMicros / 1e6 : ""} />
        </ActionForm>
      </Section>

      <Section title={`Usage in ${usage.period}`} description="AI and external services are listed separately. Runs with your own key show tokens but no charge.">
        {usage.ai.length === 0 && usage.services.length === 0 ? (
          <p className="text-sm text-graphite">No usage this month.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <caption className="sr-only">Usage this month</caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" className="py-2 pr-3">Item</th>
                  <th scope="col" className="py-2 pr-3">Paid by</th>
                  <th scope="col" className="py-2 pr-3 text-right">Quantity</th>
                  <th scope="col" className="py-2 text-right">Charge</th>
                </tr>
              </thead>
              <tbody>
                {usage.ai.map((r, i) => (
                  <tr key={`a${i}`} className="border-b border-rule-soft">
                    <td className="py-2 pr-3">AI · {r.agent} · {r.model}</td>
                    <td className="py-2 pr-3">{r.funding === "byok" ? "Your key" : "Platform"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.runs} runs · {(r.inputTokens + r.outputTokens).toLocaleString("en")} tokens</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(r.chargeMicros)}</td>
                  </tr>
                ))}
                {usage.services.map((r, i) => (
                  <tr key={`s${i}`} className="border-b border-rule-soft">
                    <td className="py-2 pr-3">Service · {r.kind}</td>
                    <td className="py-2 pr-3">{r.funding === "byok" ? "Your account" : "Platform"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.quantity.toLocaleString("en")} {r.unit}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(r.chargeMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Payments and invoices">
        {history.payments.length === 0 ? (
          <p className="text-sm text-graphite">No payments yet.</p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {history.payments.map((p) => {
              const inv = history.invoices.filter((i) => i.paymentId === p.id);
              const [label, tone] = PAY_STATUS[p.status] ?? [p.status, "todo"];
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-sheet px-4 py-2">
                  <span>
                    {formatDateTime(p.createdAt)} · {p.kind === "plan" ? "Plan" : `AI credit ${formatUsd(p.creditMicros ?? 0)}`} · {formatMoney(p.amountMinor, p.currency)} via {svc.available().find((x) => x.key === p.provider)?.name ?? p.provider}
                    {p.refundedMinor > 0 && <span className="text-graphite"> · refunded {formatMoney(p.refundedMinor, p.currency)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {inv.map((i) => <Link key={i.id} href={`/app/settings/billing/invoices/${i.id}`}>{i.kind === "credit_note" ? "Credit note" : "Invoice"} {i.number}</Link>)}
                    <Tag tone={tone}>{label}</Tag>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
