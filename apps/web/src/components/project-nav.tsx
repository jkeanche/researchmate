"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/research", label: "Research" },
  { href: "/literature", label: "Literature" },
  { href: "/documents", label: "Documents" },
  { href: "/toolkit", label: "Toolkit" },
  { href: "/reviews", label: "Reviews" },
  { href: "/workflow", label: "Workflow" },
  { href: "/schedule", label: "Schedule" },
  { href: "/tasks", label: "Tasks" },
  { href: "/calendar", label: "Calendar" },
  { href: "/risks", label: "Risks" },
  { href: "/finance", label: "Finances" },
  { href: "/time", label: "Time & workload" },
  { href: "/team", label: "Team" },
  { href: "/assistant", label: "AI assistant" },
  { href: "/search", label: "Search" },
];

export function ProjectNav({ projectId }: { projectId: string }) {
  const path = usePathname();
  const base = `/app/projects/${projectId}`;
  return (
    <nav aria-label="Project" className="no-print -mx-1 mb-8 flex gap-1 overflow-x-auto border-b border-rule pb-px">
      {TABS.map((t) => {
        const href = base + t.href;
        const active = t.href === "" ? path === base : path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={t.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-2.5 py-2 text-[0.9375rem] whitespace-nowrap no-underline ${active ? "border-green font-semibold text-ink" : "border-transparent text-graphite hover:text-ink"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
