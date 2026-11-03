"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Data and analysis" },
  { href: "/diagrams", label: "Diagrams" },
  { href: "/surveys", label: "Questionnaires" },
  { href: "/sample-size", label: "Sample size" },
  { href: "/outputs", label: "Presentations and reports" },
];

export function ToolkitNav({ projectId }: { projectId: string }) {
  const path = usePathname();
  const base = `/app/projects/${projectId}/toolkit`;
  return (
    <nav aria-label="Toolkit" className="no-print mb-6 flex flex-wrap gap-2">
      {TABS.map((t) => {
        const href = base + t.href;
        const active = t.href === "" ? path === base || path.startsWith(`${base}/datasets`) : path.startsWith(href);
        return (
          <Link key={t.href} href={href} aria-current={active ? "page" : undefined} className={`rounded-full border px-3 py-1 text-sm no-underline ${active ? "border-ink bg-ink text-paper" : "border-rule text-graphite hover:text-ink"}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
