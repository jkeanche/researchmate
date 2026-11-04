import { formatMoney, formatUsd } from "@researchmate/billing";
import Link from "next/link";
import { ActionForm, Field } from "@/components/action-form";
import { AdminButton, Select, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { adminAction } from "@/server/actions/admin";
import { planAdminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Plans & prices · Administration" };

export default async function AdminPlansPage() {
  const s = await requireSession();
  const svc = planAdminService();
  const [list, credits] = await Promise.all([svc.list(s.user.id), svc.creditPricePoints(s.user.id)]);
  return (
    <>
      <PageHeader title="Plans & prices" description="What each plan includes and what customers pay. The pricing page shows each public plan's display price; customers are charged the prices listed under the plan, per currency." />

      <Section title="Plans">
        <Table head={["Plan", "Display price", "Prices on sale", "Organizations", ""]}>
          {list.map(({ plan: p, liveSubscriptions, pricePoints }) => (
            <tr key={p.id}>
              <td>
                <Link href={`/app/admin/plans/${p.id}`} className="font-medium">{p.name}</Link>
                <span className="block font-mono text-xs text-graphite">{p.key}</span>
              </td>
              <td className="tabular-nums whitespace-nowrap">{p.priceMinor ? `${formatMoney(p.priceMinor, p.currency)} / ${p.billingInterval}` : "Free"}</td>
              <td className="text-xs">
                {pricePoints.filter((pp) => pp.active).map((pp) => <span key={pp.id} className="block">{formatMoney(pp.amountMinor, pp.currency)} / {pp.interval}</span>)}
                {!p.isDefault && pricePoints.filter((pp) => pp.active).length === 0 && <span className="text-graphite">none (can't be bought)</span>}
              </td>
              <td className="tabular-nums">{liveSubscriptions}</td>
              <td className="space-x-1 whitespace-nowrap">
                {p.isDefault && <Tag tone="done">default</Tag>}
                {!p.isActive && <Tag tone="skipped">retired</Tag>}
                {p.isActive && !p.isPublic && <Tag tone="todo">hidden</Tag>}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="AI credit packs" description="Prepaid platform AI credit customers can buy, per currency. Switched-off packs stay on past invoices.">
        <Table head={["Pack", "Price", "Credit", ""]} empty="No credit packs.">
          {credits.map((pp) => (
            <tr key={pp.id}>
              <td>{pp.label} {!pp.active && <Tag tone="skipped">off</Tag>}</td>
              <td className="tabular-nums">{formatMoney(pp.amountMinor, pp.currency)}</td>
              <td className="tabular-nums">{formatUsd(pp.creditMicros ?? 0)}</td>
              <td><AdminButton intent={pp.active ? "price.deactivate" : "price.activate"} id={pp.id} label={pp.active ? "Switch off" : "Switch on"} /></td>
            </tr>
          ))}
        </Table>
        <ActionForm action={adminAction} submitLabel="Add credit pack" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" resetOnSuccess>
          <input type="hidden" name="intent" value="price.create" />
          <input type="hidden" name="kind" value="credits" />
          <Field id="cp-label" label="Label" name="label" required placeholder="US$20 AI credit" />
          <Field id="cp-cur" label="Currency" name="currency" required defaultValue="USD" maxLength={3} />
          <Field id="cp-amt" label="Price" name="amount" required inputMode="decimal" placeholder="20.00" />
          <Field id="cp-credit" label="Credit given (US$)" name="creditUsd" required inputMode="decimal" placeholder="20" />
        </ActionForm>
      </Section>

      <Section title="New plan" description="Starts hidden, so you can set it up before it appears on the pricing page. The key is permanent and used internally.">
        <ActionForm action={adminAction} submitLabel="Create plan" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input type="hidden" name="intent" value="plan.create" />
          <input type="hidden" name="isActive" value="on" />
          <Field id="np-key" label="Key" name="key" required pattern="[a-z][a-z0-9_]{1,39}" placeholder="institution_basic" />
          <Field id="np-name" label="Name" name="name" required maxLength={60} />
          <Select id="np-copy" name="copyFromPlanId" label="Start from the features of" options={[["", "Nothing included"], ...list.map((p) => [p.plan.id, p.plan.name] as const)]} />
          <Field id="np-price" label="Display price" name="price" inputMode="decimal" defaultValue="0" />
          <Field id="np-cur" label="Currency" name="currency" defaultValue="USD" maxLength={3} required />
          <Select id="np-int" name="billingInterval" label="Per" options={[["month", "Month"], ["year", "Year"]]} />
          <Field id="np-sort" label="Order on pricing page" name="sortOrder" type="number" defaultValue={(list.at(-1)?.plan.sortOrder ?? 0) + 10} />
          <div className="field sm:col-span-2">
            <label htmlFor="np-desc">Description</label>
            <input id="np-desc" name="description" className="input" maxLength={500} />
          </div>
        </ActionForm>
      </Section>
    </>
  );
}
