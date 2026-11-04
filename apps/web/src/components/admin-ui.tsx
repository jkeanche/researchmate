import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "./action-form";
import { adminAction } from "@/server/actions/admin";

/** Builds an admin list URL, keeping the current filters. */
export function hrefWith(base: string, params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && !(k === "page" && Number(v) === 1)) q.set(k, String(v));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export function Pager({ base, params, page, total, pageSize = 50 }: { base: string; params: Record<string, string | undefined>; page: number; total: number; pageSize?: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="mt-3 text-sm text-graphite">{total.toLocaleString()} result{total === 1 ? "" : "s"}</p>;
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      {page > 1 ? <Link href={hrefWith(base, { ...params, page: page - 1 })}>← Previous</Link> : <span className="text-graphite">← Previous</span>}
      <span className="text-graphite tabular-nums">
        Page {page} of {pages} · {total.toLocaleString()} results
      </span>
      {page < pages ? <Link href={hrefWith(base, { ...params, page: page + 1 })}>Next →</Link> : <span className="text-graphite">Next →</span>}
    </nav>
  );
}

/** GET search/filter bar for admin lists. */
export function FilterBar({ action, children, q, placeholder }: { action: string; children?: ReactNode; q?: string; placeholder: string }) {
  return (
    <form action={action} method="get" className="mb-4 flex flex-wrap items-end gap-3" role="search">
      <div className="field min-w-56 flex-1">
        <label htmlFor="admin-q">Search</label>
        <input id="admin-q" name="q" type="search" className="input" defaultValue={q} placeholder={placeholder} />
      </div>
      {children}
      <div>
        <button className="btn btn-quiet" type="submit">Apply</button>
      </div>
    </form>
  );
}

export function Select({ id, name, label, value, options }: { id: string; name: string; label: string; value?: string; options: readonly (readonly [string, string])[] }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} className="input" defaultValue={value ?? ""}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A one-button administrator action (with an optional reason field). */
export function AdminButton({ intent, id, label, variant = "quiet", reason, extra }: { intent: string; id: string; label: string; variant?: "primary" | "quiet" | "danger"; reason?: string; extra?: Record<string, string> }) {
  return (
    <ActionForm action={adminAction} submitLabel={label} variant={variant} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {reason !== undefined && (
        <div className="field min-w-64">
          <label htmlFor={`r-${intent}-${id}`}>{reason}</label>
          <input id={`r-${intent}-${id}`} name="reason" className="input" required minLength={3} maxLength={500} />
        </div>
      )}
    </ActionForm>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-graphite">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  if (!hasRows && empty) return <p className="rounded-md border border-dashed border-rule px-4 py-6 text-sm text-graphite">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-rule bg-sheet">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule text-left">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-rule-soft [&>tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}

export const SUB_TONE: Record<string, string> = { active: "in_progress", trialing: "in_progress", past_due: "blocked", canceled: "skipped", expired: "skipped" };
export const TICKET_TONE: Record<string, string> = { open: "open", pending: "awaiting_approval", resolved: "done", closed: "closed" };
export const STATUS_LABEL: Record<string, string> = { open: "Waiting for us", pending: "Waiting for requester", resolved: "Resolved", closed: "Closed", active: "Active", trialing: "Trial", past_due: "Past due", canceled: "Canceled", expired: "Expired", disabled: "Disabled" };
