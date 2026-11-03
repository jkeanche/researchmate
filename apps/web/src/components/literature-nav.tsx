"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Library" },
  { href: "/search", label: "Find sources" },
  { href: "/evidence", label: "Evidence" },
  { href: "/matrix", label: "Literature matrix" },
  { href: "/passages", label: "Search documents" },
];

export function LiteratureNav({ projectId }: { projectId: string }) {
  const path = usePathname();
  const base = `/app/projects/${projectId}/literature`;
  return (
    <nav aria-label="Literature" className="no-print mb-6 flex flex-wrap gap-2">
      {TABS.map((t) => {
        const href = base + t.href;
        const active = t.href === "" ? path === base : path.startsWith(href);
        return (
          <Link key={t.href} href={href} aria-current={active ? "page" : undefined} className={`rounded-full border px-3 py-1 text-sm no-underline ${active ? "border-ink bg-ink text-paper" : "border-rule text-graphite hover:text-ink"}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
