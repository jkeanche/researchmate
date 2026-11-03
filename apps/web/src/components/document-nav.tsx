"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Write" },
  { href: "/preview", label: "Preview" },
  { href: "/audit", label: "Checks & citations" },
  { href: "/versions", label: "Versions & export" },
  { href: "/settings", label: "Specification" },
];

export function DocumentNav({ base }: { base: string }) {
  const path = usePathname();
  return (
    <nav aria-label="Document" className="no-print mb-6 flex flex-wrap gap-2">
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
