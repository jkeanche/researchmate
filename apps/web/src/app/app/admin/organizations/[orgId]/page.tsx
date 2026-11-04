import { FEATURE_LIST, formatEntitlementValue } from "@researchmate/admin";
import { formatMoney, formatUsd } from "@researchmate/billing";
import { formatBytes } from "@researchmate/entitlements";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { AdminButton, KeyValue, Select, STATUS_LABEL, SUB_TONE, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { Meter, PageHeader, Section } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { adminAction } from "@/server/actions/admin";
import { adminService, planAdminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Organization · Administration" };

const LIMIT_LABELS: Record<string, string> = { "projects.max": "Projects", "files.max": "Files", "storage.max_bytes": "Storage", "members.max": "Members", "ai.runs.monthly": "AI runs this month", "planning.tasks.max": "Tasks (largest project)", "files.max_size_bytes": "Largest file", "ai.platform.allowance": "Platform AI allowance" };

export default async function AdminOrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const s = await requireSession();
  const { orgId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orgId)) notFound();
  const d = await adminService().getOrganization(s.user.id, orgId).catch(() => null);
  if (!d) notFound();
  const planRows = await planAdminService().list(s.user.id);
  const plans = planRows.map((p) => p.plan);
  const live = d.live;
  const ent = d.limits.entitlements;
  // What the plan itself gives, before this organization's overrides.
  const planValues = planRows.find((p) => p.plan.id === ent.planId)?.entitlements ?? {};
  const fmt = (key: string) => (n: number) => (key.includes("bytes") ? formatBytes(n) : key === "ai.platform.allowance" ? formatUsd(n) : n.toLocaleString());

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/app/admin/organizations">← Organizations</Link></p>
      <PageHeader
        title={d.org.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {d.org.kind === "personal" ? "Personal workspace" : "Team organization"} · owner {d.owner ? <Link href={`/app/admin/users/${d.owner.id}`}>{d.owner.email}</Link> : "unknown"}
            {d.org.deletedAt && <Tag tone="blocked">scheduled for deletion {d.org.purgeAfter ? `on ${formatDate(d.org.purgeAfter)}` : ""}</Tag>}
          </span>
        }
      />

      {d.org.deletedAt && (
        <Section title="Scheduled deletion">
          <p className="mb-3 text-sm text-graphite">The owner deleted this workspace on {formatDate(d.org.deletedAt)}. It is inaccessible and will be purged{d.org.purgeAfter ? ` on ${formatDate(d.org.purgeAfter)}` : ""}. Restoring makes it available again for all members.</p>
          {d.org.purgeStartedAt ? <p className="text-sm text-margin">The purge has started; it can no longer be restored.</p> : <AdminButton intent="org.restore" id={d.org.id} label="Restore organization" variant="primary" />}
        </Section>
      )}

      <div className="grid gap-x-10 lg:grid-cols-2">
        <Section title="Plan">
          {live ? (
            <KeyValue
              rows={[
                ["Plan", <span key="p" className="flex items-center gap-2">{live.plan} <Tag tone={SUB_TONE[live.s.status] ?? live.s.status}>{STATUS_LABEL[live.s.status] ?? live.s.status}</Tag></span>],
                ["Since", formatDate(live.s.currentPeriodStart)],
                ["Ends", live.s.currentPeriodEnd ? `${formatDate(live.s.currentPeriodEnd)}${live.s.cancelAtPeriodEnd ? " (won't renew)" : ""}` : "no end date"],
                ["Paid through", live.s.provider === "manual" ? "assigned by an administrator" : live.s.provider],
              ]}
            />
          ) : (
            <p className="text-sm text-graphite">No subscription; the default plan ({ent.planName}) applies.</p>
          )}
          <p className="mt-3 text-sm text-graphite">{d.projectCount} project(s) · {d.members.length} member(s) · {d.invoiceCount} invoice(s) · created {formatDate(d.org.createdAt)}</p>
        </Section>

        <Section title="Usage">
          <div className="grid gap-3">
            {d.limits.limits.filter((l) => !["files.max_size_bytes", "ai.platform.allowance"].includes(l.key)).map((l) => (
              <Meter key={l.key} label={LIMIT_LABELS[l.key] ?? l.key} used={l.used} limit={l.limit} format={fmt(l.key)} />
            ))}
          </div>
        </Section>
      </div>

      <Section title="Change plan" description="Assigns a plan without a payment: complimentary access, an institutional agreement, or fixing a mistake. With an end date, the organization returns to the default plan after it (with the usual reminder emails); without one, the plan continues until changed. The owner is notified.">
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionForm action={adminAction} submitLabel="Assign plan" className="grid gap-3">
            <input type="hidden" name="intent" value="org.assign_plan" />
            <input type="hidden" name="id" value={d.org.id} />
            <Select id="ap-plan" name="planId" label="Plan" value={live?.s.planId} options={plans.filter((p) => p.isActive).map((p) => [p.id, `${p.name}${p.isDefault ? " (default)" : ""}`] as const)} />
            <Field id="ap-end" label="Ends on (optional)" name="periodEnd" type="date" />
            <Field id="ap-reason" label="Reason" name="reason" required minLength={3} maxLength={500} />
          </ActionForm>
          {live && (
            <div className="grid content-start gap-6">
              <ActionForm action={adminAction} submitLabel="Change end date" variant="quiet" className="grid gap-3">
                <input type="hidden" name="intent" value="org.set_period_end" />
                <input type="hidden" name="id" value={d.org.id} />
                <Field id="pe-end" label="New end date (empty = no end)" name="periodEnd" type="date" defaultValue={live.s.currentPeriodEnd?.toISOString().slice(0, 10)} />
                <Field id="pe-reason" label="Reason" name="reason" required minLength={3} maxLength={500} />
              </ActionForm>
              {plans.find((p) => p.id === live.s.planId && !p.isDefault) && (
                <ActionForm action={adminAction} submitLabel="Cancel plan" variant="danger" className="grid gap-3">
                  <input type="hidden" name="intent" value="org.cancel" />
                  <input type="hidden" name="id" value={d.org.id} />
                  <Select id="cn-when" name="when" label="When" options={[["end", "At the end of the period"], ["now", "Now (move to the default plan)"]]} />
                  <Field id="cn-reason" label="Reason" name="reason" required minLength={3} maxLength={500} />
                </ActionForm>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="Feature overrides" description="Grants (or limits) a feature for this organization only, whatever its plan, optionally until a date. Limits accept “unlimited”; sizes accept MB/GB; the AI allowance is in US dollars per month.">
        <Table head={["Feature", "Plan value", "Override", "Until", "Reason", ""]} empty="No overrides; the plan's values apply.">
          {d.overrides.map(({ o, setBy }) => (
            <tr key={o.featureKey}>
              <td className="font-mono text-xs">{o.featureKey}</td>
              <td>{formatEntitlementValue(o.featureKey as never, planValues[o.featureKey as keyof typeof planValues])}</td>
              <td className="font-semibold">{formatEntitlementValue(o.featureKey as never, o.value)}</td>
              <td className="whitespace-nowrap">{o.expiresAt ? (o.expiresAt < new Date() ? <Tag tone="skipped">expired {formatDate(o.expiresAt)}</Tag> : formatDate(o.expiresAt)) : "—"}</td>
              <td className="text-xs">{o.reason}<span className="block text-graphite">{setBy ?? ""} · {formatDate(o.createdAt)}</span></td>
              <td><AdminButton intent="org.remove_override" id={d.org.id} label="Remove" extra={{ featureKey: o.featureKey }} /></td>
            </tr>
          ))}
        </Table>
        <ActionForm action={adminAction} submitLabel="Save override" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="intent" value="org.override" />
          <input type="hidden" name="id" value={d.org.id} />
          <Select id="ov-key" name="featureKey" label="Feature" options={FEATURE_LIST.map((f) => [f.key, `${f.description} (${f.key})`] as const)} />
          <Field id="ov-val" label="Value" name="value" required placeholder="on, full, 10 GB, unlimited…" />
          <Field id="ov-exp" label="Until (optional)" name="expiresAt" type="date" />
          <Field id="ov-reason" label="Reason" name="reason" required minLength={3} maxLength={500} />
        </ActionForm>
      </Section>

      <Section title="AI credit" description="Prepaid credit for platform-funded AI. Adjustments are kept in the ledger permanently; enter a negative amount to remove credit.">
        <p className="mb-3 text-sm">Balance: <strong className="tabular-nums">{formatUsd(d.creditMicros)}</strong></p>
        <ActionForm action={adminAction} submitLabel="Adjust credit" className="mb-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="org.credit" />
          <input type="hidden" name="id" value={d.org.id} />
          <Field id="cr-usd" label="Amount (US$)" name="usd" type="number" step="0.01" required />
          <Field id="cr-reason" label="Reason" name="reason" required minLength={3} maxLength={500} />
        </ActionForm>
        {d.ledger.length > 0 && (
          <Table head={["Date", "Kind", "Amount", "Description"]}>
            {d.ledger.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                <td>{l.kind} · {l.pool}</td>
                <td className="tabular-nums">{formatUsd(l.amountMicros)}</td>
                <td className="text-xs">{l.description}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Members">
        <Table head={["Member", "Role", "Joined"]}>
          {d.members.map((m) => (
            <tr key={m.id}>
              <td><Link href={`/app/admin/users/${m.id}`}>{m.name ?? m.email}</Link><span className="block text-xs text-graphite">{m.email}{m.status !== "active" ? " · disabled" : ""}</span></td>
              <td>{m.id === d.org.ownerUserId ? "Owner" : m.role}</td>
              <td className="whitespace-nowrap">{formatDate(m.joinedAt)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Payments" aside={<Link href="/app/admin/billing" className="text-sm">All payments</Link>}>
        <Table head={["Date", "What", "Amount", "Provider", "Status"]} empty="No payments.">
          {d.payments.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">{formatDateTime(p.createdAt)}</td>
              <td>{p.kind === "plan" ? `Plan (${p.interval})` : `AI credit ${formatUsd(p.creditMicros ?? 0)}`}</td>
              <td className="tabular-nums">{formatMoney(p.amountMinor, p.currency)}{p.refundedMinor ? <span className="block text-xs text-graphite">refunded {formatMoney(p.refundedMinor, p.currency)}</span> : null}</td>
              <td>{p.provider}<span className="block font-mono text-[0.6875rem] text-graphite">{p.reference}</span></td>
              <td><Tag tone={p.status === "succeeded" ? "done" : p.status === "pending" ? "awaiting_approval" : "skipped"}>{p.status}</Tag></td>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="grid gap-x-10 lg:grid-cols-2">
        <Section title="Subscription history">
          <ul className="grid gap-1 text-sm">
            {d.subscriptions.map(({ s: x, plan }) => (
              <li key={x.id} className="flex flex-wrap justify-between gap-2 border-b border-rule-soft py-1">
                <span>{plan} <Tag tone={SUB_TONE[x.status] ?? x.status}>{STATUS_LABEL[x.status] ?? x.status}</Tag> <span className="text-xs text-graphite">{x.provider}</span></span>
                <span className="text-graphite">{formatDate(x.currentPeriodStart)} – {x.currentPeriodEnd ? formatDate(x.currentPeriodEnd) : "open"}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Recent activity" aside={<Link href={`/app/admin/audit?org=${d.org.id}`} className="text-sm">Full log</Link>}>
          <ul className="grid gap-1 text-sm">
            {d.audit.length === 0 && <li className="text-graphite">Nothing recorded.</li>}
            {d.audit.map(({ a, actorEmail }) => (
              <li key={a.id} className="border-b border-rule-soft py-1">
                <span className="font-mono text-xs">{a.action}</span> <span className="text-graphite">by {actorEmail ?? "system"} · {formatDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
