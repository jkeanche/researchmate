import type { UserFilter } from "@researchmate/admin";
import Link from "next/link";
import { FilterBar, Pager, Select, Table } from "@/components/admin-ui";
import { Tag } from "@/components/plan-ui";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { adminService } from "@/server/services";
import { requireSession } from "@/server/session";

export const metadata = { title: "Users · Administration" };

const FILTERS = [["all", "All users"], ["active", "Active"], ["disabled", "Disabled"], ["unverified", "Unverified email"], ["admins", "Administrators"]] as const;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; page?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const filter = (FILTERS.find(([v]) => v === sp.filter)?.[0] ?? "all") as UserFilter;
  const r = await adminService().listUsers(s.user.id, { q: sp.q, filter, page: Number(sp.page) || 1 });
  return (
    <>
      <PageHeader title="Users" description="Everyone with an account. Open a user to change their access, verify them, reset their sign-in or see their workspaces." />
      <FilterBar action="/app/admin/users" q={sp.q} placeholder="Email, name or institution">
        <Select id="uf" name="filter" label="Show" value={filter} options={FILTERS} />
      </FilterBar>
      <Table head={["User", "Status", "Workspaces", "Last sign-in", "Joined"]} empty="No users match.">
        {r.rows.map((u) => (
          <tr key={u.id}>
            <td>
              <Link href={`/app/admin/users/${u.id}`} className="font-medium">{u.name ?? u.email}</Link>
              <span className="block text-xs text-graphite">{u.email}{u.institution ? ` · ${u.institution}` : ""}</span>
            </td>
            <td className="space-x-1 whitespace-nowrap">
              <Tag tone={u.status === "active" ? "in_progress" : "blocked"}>{u.status === "active" ? "Active" : "Disabled"}</Tag>
              {!u.emailVerifiedAt && <Tag tone="awaiting_approval">unverified</Tag>}
              {u.isPlatformAdmin && <Tag tone="done">admin</Tag>}
              {u.twoFactor && <Tag tone="todo">2FA</Tag>}
            </td>
            <td className="tabular-nums">{u.organizations}</td>
            <td className="whitespace-nowrap">{u.lastLoginAt ? formatDate(u.lastLoginAt) : "never"}</td>
            <td className="whitespace-nowrap">{formatDate(u.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Pager base="/app/admin/users" params={{ q: sp.q, filter }} page={r.page} total={r.total} />
    </>
  );
}
