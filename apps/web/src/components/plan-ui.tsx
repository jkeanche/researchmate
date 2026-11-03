import Link from "next/link";
import type { ReactNode } from "react";

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_LABELS: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const DEP_TYPE_LABELS: Record<string, string> = {
  FS: "Finish → start",
  SS: "Start → start",
  FF: "Finish → finish",
  SF: "Start → finish",
};

const STATUS_STYLE: Record<string, string> = {
  todo: "border-rule text-graphite",
  in_progress: "border-green/40 text-green-dark",
  blocked: "border-margin/40 text-margin",
  in_review: "border-amber/40 text-amber",
  done: "border-ink/30 text-ink bg-rule-soft",
  cancelled: "border-rule text-graphite line-through",
  not_started: "border-rule text-graphite",
  awaiting_approval: "border-amber/40 text-amber bg-amber-wash",
  completed: "border-ink/30 text-ink bg-rule-soft",
  skipped: "border-rule text-graphite line-through",
  open: "border-margin/40 text-margin",
  mitigating: "border-amber/40 text-amber",
  occurred: "border-margin/60 text-margin bg-margin-wash",
  closed: "border-rule text-graphite",
};

export function Tag({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLE[tone] ?? "border-rule text-graphite"}`}>
      {children}
    </span>
  );
}

export function TaskStatusTag({ status }: { status: string }) {
  return <Tag tone={status}>{TASK_STATUS_LABELS[status] ?? status}</Tag>;
}

export function Flag({ kind }: { kind: "overdue" | "late" | "critical" | "locked" }) {
  const map = {
    overdue: ["Overdue", "border-margin/50 bg-margin-wash text-margin", "Past its end date and not done"],
    late: ["Late start", "border-amber/40 bg-amber-wash text-amber", "Should have started already"],
    critical: ["Critical", "border-margin/40 text-margin", "On the critical path: any delay delays the project"],
    locked: ["Approved deadline", "border-ink/30 text-ink", "Only an approver can move this date"],
  } as const;
  const [label, cls, title] = map[kind];
  return (
    <span title={title} className={`inline-block rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "bad" | "warn" | "good" }) {
  const color = tone === "bad" ? "text-margin" : tone === "warn" ? "text-amber" : tone === "good" ? "text-green-dark" : "text-ink";
  return (
    <div className="rounded-md border border-rule bg-sheet px-4 py-3">
      <p className="text-sm text-graphite">{label}</p>
      <p className={`mt-0.5 font-serif text-2xl tabular-nums ${color}`}>{value}</p>
      {note ? <p className="mt-0.5 text-xs text-graphite">{note}</p> : null}
    </div>
  );
}

/** Explains a plan limit, linking to the organization page where plans are shown. */
export function PlanNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-amber/30 bg-amber-wash px-3 py-2 text-sm text-amber">
      {children} <Link href="/app/settings/organization" className="font-semibold">See plans</Link>
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-rule bg-rule-soft px-3 py-2 text-sm text-graphite">{children}</p>;
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}
