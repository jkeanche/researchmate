import { FEATURE_LIST, formatEntitlementValue } from "@researchmate/admin";
import { formatMoney } from "@researchmate/billing";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { AdminButton, Select, Table } from "@/components/admin-ui";
import { Notice, Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { adminAction } from "@/server/actions/admin";
import { planAdminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Plan · Administration" };

const GROUPS: [string, (k: string) => boolean][] = [
  ["Limits", (k) => FEATURE_LIST.find((f) => f.key === k)?.kind === "limit"],
  ["Capabilities", (k) => FEATURE_LIST.find((f) => f.key === k)?.kind === "tier"],
  ["Features", (k) => FEATURE_LIST.find((f) => f.key === k)?.kind === "flag"],
];

function hint(f: (typeof FEATURE_LIST)[number]) {
  if (f.kind === "tier") return null;
  if (f.kind === "flag") return null;
  if (f.unit === "bytes") return "e.g. 500 MB, 5 GB, or unlimited";
  if (f.unit === "micro_usd") return "US$ per month";
  return "a number, or unlimited";
}

export default async function AdminPlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const s = await requireSession();
  const { planId } = await params;
  const all = await planAdminService().list(s.user.id);
  const row = all.find((p) => p.plan.id === planId);
  if (!row) notFound();
  const { plan: p, entitlements, liveSubscriptions, pricePoints } = row;

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/app/admin/plans">← Plans & prices</Link></p>
      <PageHeader
        title={p.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{p.key}</span> · {liveSubscriptions} organization(s) on this plan
            {p.isDefault && <Tag tone="done">default plan</Tag>}
            {!p.isActive && <Tag tone="skipped">retired</Tag>}
            {p.isActive && !p.isPublic && <Tag tone="todo">hidden from pricing page</Tag>}
          </span>
        }
      />

      <Section title="Details">
        <ActionForm action={adminAction} submitLabel="Save details" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input type="hidden" name="intent" value="plan.update" />
          <input type="hidden" name="id" value={p.id} />
          <Field id="pl-name" label="Name" name="name" required defaultValue={p.name} maxLength={60} />
          <Field id="pl-price" label="Display price" name="price" inputMode="decimal" defaultValue={(p.priceMinor / 100).toFixed(2)} hint={p.isDefault ? "The default plan is free." : "Shown on the pricing page"} />
          <Field id="pl-cur" label="Currency" name="currency" required defaultValue={p.currency} maxLength={3} />
          <Select id="pl-int" name="billingInterval" label="Per" value={p.billingInterval} options={[["month", "Month"], ["year", "Year"]]} />
          <Field id="pl-sort" label="Order on pricing page" name="sortOrder" type="number" defaultValue={p.sortOrder} />
          <div className="grid content-end gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="isPublic" defaultChecked={p.isPublic} /> Shown on the pricing page</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={p.isActive} disabled={p.isDefault} /> Available (unticking retires the plan and switches off its prices)</label>
            {p.isDefault && <input type="hidden" name="isActive" value="on" />}
          </div>
          <div className="field sm:col-span-2 lg:col-span-3">
            <label htmlFor="pl-desc">Description</label>
            <input id="pl-desc" name="description" className="input" defaultValue={p.description} maxLength={500} />
          </div>
        </ActionForm>
        {!p.isDefault && p.isActive && p.priceMinor === 0 && (
          <div className="mt-4">
            <p className="mb-1 text-sm text-graphite">The default plan is given to new organizations and to those whose paid plan ends.</p>
            <AdminButton intent="plan.default" id={p.id} label="Make this the default plan" />
          </div>
        )}
      </Section>

      <Section title="What this plan includes" description="Changes apply immediately to every organization on this plan, except where an organization has its own override. Lowering a limit never deletes anything: content above the new limit becomes read-only.">
        {liveSubscriptions > 0 && <div className="mb-4"><Notice>{liveSubscriptions} organization(s) are on this plan now.</Notice></div>}
        <ActionForm action={adminAction} submitLabel="Save features" className="grid gap-8">
          <input type="hidden" name="intent" value="plan.entitlements" />
          <input type="hidden" name="id" value={p.id} />
          {GROUPS.map(([title, match]) => (
            <fieldset key={title}>
              <legend className="mb-3 font-serif text-lg">{title}</legend>
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {FEATURE_LIST.filter((f) => match(f.key)).map((f) => {
                  const value = formatEntitlementValue(f.key, entitlements[f.key]);
                  const id = `ent-${f.key.replace(/\./g, "-")}`;
                  if (f.kind === "tier" || f.kind === "flag") {
                    const options = f.kind === "flag" ? (["off", "on"] as const) : f.tiers;
                    return (
                      <div key={f.key} className="field">
                        <label htmlFor={id}>{f.description}</label>
                        <select id={id} name={`ent:${f.key}`} className="input" defaultValue={value}>
                          {options.map((o) => <option key={o} value={o}>{o === "none" ? "none (not available)" : o}</option>)}
                        </select>
                        <span className="hint font-mono">{f.key}</span>
                      </div>
                    );
                  }
                  return <Field key={f.key} id={id} label={f.description} name={`ent:${f.key}`} defaultValue={value} hint={`${hint(f)} · ${f.key}`} required />;
                })}
              </div>
            </fieldset>
          ))}
        </ActionForm>
      </Section>

      {!p.isDefault && (
        <Section title="Prices customers pay" description="Each price is one period of this plan in one currency (e.g. USD by card, KES by M-PESA). A price can't be edited once created; switch it off and add a new one. Payment providers only offer prices in currencies they support.">
          <Table head={["Label", "Price", "Period", ""]} empty="No prices yet: customers can't buy this plan.">
            {pricePoints.map((pp) => (
              <tr key={pp.id}>
                <td>{pp.label} {!pp.active && <Tag tone="skipped">off</Tag>}</td>
                <td className="tabular-nums">{formatMoney(pp.amountMinor, pp.currency)}</td>
                <td>{pp.interval}</td>
                <td><AdminButton intent={pp.active ? "price.deactivate" : "price.activate"} id={pp.id} label={pp.active ? "Switch off" : "Switch on"} /></td>
              </tr>
            ))}
          </Table>
          {p.isActive && (
            <ActionForm action={adminAction} submitLabel="Add price" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" resetOnSuccess>
              <input type="hidden" name="intent" value="price.create" />
              <input type="hidden" name="kind" value="plan" />
              <input type="hidden" name="planId" value={p.id} />
              <Field id="pp-label" label="Label" name="label" required defaultValue={`${p.name} (monthly)`} />
              <Field id="pp-cur" label="Currency" name="currency" required defaultValue={p.currency} maxLength={3} />
              <Field id="pp-amt" label="Price" name="amount" required inputMode="decimal" defaultValue={(p.priceMinor / 100).toFixed(2)} />
              <Select id="pp-int" name="interval" label="Period" value={p.billingInterval} options={[["month", "One month"], ["year", "One year"]]} />
            </ActionForm>
          )}
        </Section>
      )}
    </>
  );
}
