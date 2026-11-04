import { formatMoney, formatUsd } from "@researchmate/billing";
import Link from "next/link";
import { Table } from "@/components/admin-ui";
import { Stat, Tag } from "@/components/plan-ui";
import { PageHeader, Section } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { systemSnapshot } from "@/server/metrics";
import { adminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Administration" };

export default async function AdminOverviewPage() {
  const s = await requireSession();
  const [o, sys] = await Promise.all([adminService().overview(s.user.id), systemSnapshot()]);
  const healthy = sys.database === "ok" && sys.redis === "ok" && sys.storage === "ok" && sys.workerAgeSeconds !== null;
  const plans = new Map<string, { plan: string; active: number; pastDue: number; paid: boolean }>();
  for (const r of o.subscriptions) {
    const p = plans.get(r.planId) ?? { plan: r.plan, active: 0, pastDue: 0, paid: r.priceMinor > 0 };
    if (r.status === "past_due") p.pastDue += r.n;
    else p.active += r.n;
    plans.set(r.planId, p);
  }
  const paying = [...plans.values()].filter((p) => p.paid).reduce((n, p) => n + p.active + p.pastDue, 0);

  return (
    <>
      <PageHeader title="Overview" description="The whole platform at a glance. Figures are live." />

      {!healthy && (
        <p role="alert" className="mb-8 rounded-md border border-margin/30 bg-margin-wash px-3 py-2 text-sm text-margin">
          Something needs attention: {[sys.database !== "ok" && "database", sys.redis !== "ok" && "Redis", sys.storage !== "ok" && "file storage", sys.workerAgeSeconds === null && "background worker"].filter(Boolean).join(", ")}. <Link href="/app/admin/system">See System</Link>
        </p>
      )}

      <div className="mb-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/app/admin/users" className="no-underline"><Stat label="Users" value={o.users.active.toLocaleString()} note={`${o.users.new7} new this week · ${o.users.active30} signed in this month`} /></Link>
        <Link href="/app/admin/organizations" className="no-underline"><Stat label="Organizations" value={o.organizations.total.toLocaleString()} note={`${o.organizations.team} team · ${o.organizations.scheduled} awaiting deletion`} /></Link>
        <Link href="/app/admin/subscriptions?filter=paid" className="no-underline"><Stat label="On a paid plan" value={paying.toLocaleString()} note={o.expiringSoon ? `${o.expiringSoon} ending within 14 days` : "none ending soon"} tone={o.expiringSoon ? "warn" : undefined} /></Link>
        <Link href="/app/admin/enquiries" className="no-underline"><Stat label="Enquiries waiting" value={o.enquiries.open} note={`${o.enquiries.unassigned} unassigned · ${o.enquiries.pending} waiting for requesters`} tone={o.enquiries.open ? "warn" : "good"} /></Link>
      </div>

      <div className="grid gap-x-10 lg:grid-cols-2">
        <Section title="Revenue, last 30 days" description="Successful payments less refunds, per currency (no conversion).">
          {o.revenue30.length === 0 ? (
            <p className="text-sm text-graphite">No payments in the last 30 days.</p>
          ) : (
            <Table head={["Currency", "Payments", "Gross", "Refunded", "Net"]}>
              {o.revenue30.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td className="tabular-nums">{r.payments}</td>
                  <td className="tabular-nums">{formatMoney(r.gross, r.currency)}</td>
                  <td className="tabular-nums">{formatMoney(r.refunded, r.currency)}</td>
                  <td className="font-semibold tabular-nums">{formatMoney(r.net, r.currency)}</td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-3 text-sm text-graphite">
            {o.payments.pending} pending · {o.payments.failed30} failed this month · platform AI usage {formatUsd(o.aiSpend30Micros)} · <Link href="/app/admin/billing">Payments</Link>
          </p>
        </Section>

        <Section title="Subscriptions by plan">
          <Table head={["Plan", "Active", "Past due"]} empty="No subscriptions yet.">
            {[...plans.entries()].map(([id, p]) => (
              <tr key={id}>
                <td><Link href={`/app/admin/subscriptions?plan=${id}`}>{p.plan}</Link></td>
                <td className="tabular-nums">{p.active}</td>
                <td className="tabular-nums">{p.pastDue ? <Tag tone="blocked">{p.pastDue}</Tag> : 0}</td>
              </tr>
            ))}
          </Table>
        </Section>

        <Section title="Newest users" aside={<Link href="/app/admin/users" className="text-sm">All users</Link>}>
          <Table head={["User", "Joined", ""]} empty="No users yet.">
            {o.recentUsers.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/app/admin/users/${u.id}`}>{u.name ?? u.email}</Link>
                  <span className="block text-xs text-graphite">{u.email}</span>
                </td>
                <td className="whitespace-nowrap">{formatDate(u.createdAt)}</td>
                <td>{!u.verified && <Tag tone="awaiting_approval">unverified</Tag>}</td>
              </tr>
            ))}
          </Table>
        </Section>

        <Section title="Accounts">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ["Disabled accounts", o.users.disabled, "/app/admin/users?filter=disabled"],
              ["Unverified email", o.users.unverified, "/app/admin/users?filter=unverified"],
              ["Platform administrators", o.users.admins, "/app/admin/users?filter=admins"],
              ["New this month", o.users.new30, "/app/admin/users"],
            ].map(([label, n, href]) => (
              <Link key={label as string} href={href as string} className="rounded-md border border-rule bg-sheet px-3 py-2 no-underline">
                <dt className="text-graphite">{label}</dt>
                <dd className="font-serif text-xl tabular-nums">{n}</dd>
              </Link>
            ))}
          </dl>
        </Section>
      </div>
    </>
  );
}
