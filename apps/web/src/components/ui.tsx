import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-[2rem]">{title}</h1>
        {description ? <div className="mt-2 text-graphite">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, description, children, aside }: { title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2">
        <h2 className="text-xl">{title}</h2>
        {aside}
      </div>
      {description ? <p className="-mt-1 mb-4 max-w-2xl text-sm text-graphite">{description}</p> : null}
      {children}
    </section>
  );
}

/** Progress drawn as a ruled bar with tick marks every 25%. */
export function ProgressRule({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-3" aria-label={`${label}: ${v}%`}>
      <div className="relative h-2 w-28 rounded-sm bg-rule-soft sm:w-40" role="presentation">
        <div className="absolute inset-y-0 left-0 rounded-sm bg-green" style={{ width: `${v}%` }} />
        {[25, 50, 75].map((t) => (
          <span key={t} className="absolute inset-y-0 w-px bg-sheet/90" style={{ left: `${t}%` }} />
        ))}
      </div>
      <span className="w-9 text-right text-sm tabular-nums text-graphite">{v}%</span>
    </div>
  );
}

export function Meter({ used, limit, label, format }: { used: number; limit: number | null; label: string; format: (n: number) => string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = limit !== null && used > limit;
  const near = !over && limit !== null && pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className={`tabular-nums ${over ? "font-semibold text-margin" : "text-graphite"}`}>
          {format(used)} of {limit === null ? "unlimited" : format(limit)}
        </span>
      </div>
      {limit !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-rule-soft" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={`h-full ${over ? "bg-margin" : near ? "bg-amber" : "bg-green"}`} style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }} />
        </div>
      )}
    </div>
  );
}

export function StatusTag({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "border-rule text-graphite",
    active: "border-green/40 text-green-dark",
    on_hold: "border-amber/40 text-amber",
    completed: "border-ink/30 text-ink",
    archived: "border-rule text-graphite bg-rule-soft",
  };
  const labels: Record<string, string> = { draft: "Draft", active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}>{labels[status] ?? status}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="rounded-md border border-dashed border-rule px-6 py-8">
      <p className="font-serif text-lg">{title}</p>
      <p className="mt-1 max-w-lg text-sm text-graphite">{body}</p>
      {action ? (
        <Link href={action.href} className="btn btn-primary mt-4">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
