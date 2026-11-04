"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/app/admin", "Overview"],
  ["/app/admin/users", "Users"],
  ["/app/admin/organizations", "Organizations"],
  ["/app/admin/subscriptions", "Subscriptions"],
  ["/app/admin/plans", "Plans & prices"],
  ["/app/admin/billing", "Payments & AI pricing"],
  ["/app/admin/enquiries", "Enquiries"],
  ["/app/admin/audit", "Audit log"],
  ["/app/admin/system", "System"],
] as const;

export function AdminNav({ openEnquiries }: { openEnquiries: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Administration" className="mb-8 flex flex-wrap gap-x-1 border-b border-rule pb-px">
      {TABS.map(([href, label]) => {
        const active = href === "/app/admin" ? path === href : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap no-underline ${active ? "border-ink font-semibold text-ink" : "border-transparent text-graphite hover:text-ink"}`}
          >
            {label}
            {href === "/app/admin/enquiries" && openEnquiries > 0 && (
              <span className="rounded-full bg-margin px-1.5 text-xs font-semibold text-paper tabular-nums" aria-label={`${openEnquiries} waiting`}>
                {openEnquiries > 99 ? "99+" : openEnquiries}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
