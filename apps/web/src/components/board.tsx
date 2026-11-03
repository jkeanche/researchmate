"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { boardStatusAction } from "@/server/actions/planning";

export interface BoardCard {
  id: string;
  wbs: string;
  title: string;
  kind: string;
  status: string;
  priority: string;
  endDate: string;
  assigneeName: string | null;
  canMove: boolean;
  overdue: boolean;
  critical: boolean;
  progress: number;
}

const COLUMNS = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "in_review", label: "In review" },
  { key: "done", label: "Done" },
];

export function Board({ cards, projectId }: { cards: BoardCard[]; projectId: string }) {
  const router = useRouter();
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const statusOf = (c: BoardCard) => moving[c.id] ?? c.status;

  function move(id: string, status: string) {
    const card = cards.find((c) => c.id === id);
    if (!card || statusOf(card) === status) return;
    setMoving((m) => ({ ...m, [id]: status }));
    setMsg(null);
    start(async () => {
      const r = await boardStatusAction({ taskId: id, status });
      if (!r.ok) setMsg({ tone: "err", text: r.error });
      else if (r.message) setMsg({ tone: "ok", text: r.message });
      setMoving((m) => {
        const { [id]: _, ...rest } = m;
        return rest;
      });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3">
      <div aria-live="polite">
        {pending && <p className="text-sm text-graphite">Saving…</p>}
        {msg && <p role={msg.tone === "err" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${msg.tone === "err" ? "border-margin/30 bg-margin-wash text-margin" : "border-green/30 bg-green-wash text-green-dark"}`}>{msg.text}</p>}
      </div>
      <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-5">
        {COLUMNS.map((col) => {
          const list = cards.filter((c) => statusOf(c) === col.key);
          return (
            <section
              key={col.key}
              aria-label={col.label}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(col.key);
              }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                move(e.dataTransfer.getData("text/plain"), col.key);
              }}
              className={`min-h-40 rounded-md border p-2 ${over === col.key ? "border-green bg-green-wash" : "border-rule bg-rule-soft/50"}`}
            >
              <h3 className="mb-2 flex items-baseline justify-between px-1 font-sans text-sm font-semibold">
                {col.label} <span className="font-normal text-graphite tabular-nums">{list.length}</span>
              </h3>
              <ul className="grid gap-2">
                {list.map((c) => (
                  <li
                    key={c.id}
                    draggable={c.canMove}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
                    className={`rounded-md border bg-sheet p-2.5 text-sm shadow-[0_1px_0_rgba(27,42,58,0.06)] ${c.overdue ? "border-margin/50" : "border-rule"} ${c.canMove ? "cursor-grab" : ""}`}
                  >
                    <p className="text-xs text-graphite">
                      {c.wbs} {c.kind === "milestone" ? "· Milestone" : ""} {c.critical ? <span className="font-semibold text-margin">· Critical</span> : null}
                    </p>
                    <Link href={`/app/projects/${projectId}/tasks/${c.id}`} className="font-medium">{c.title}</Link>
                    <p className={`mt-1 text-xs ${c.overdue ? "font-semibold text-margin" : "text-graphite"}`}>
                      {c.overdue ? "Overdue · " : "Due "}
                      {new Date(`${c.endDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
                      {c.assigneeName ? ` · ${c.assigneeName}` : ""}
                    </p>
                    {c.progress > 0 && c.progress < 100 && (
                      <div className="mt-1.5 h-1 rounded bg-rule-soft" aria-label={`${c.progress}% complete`}>
                        <div className="h-full rounded bg-green" style={{ width: `${c.progress}%` }} />
                      </div>
                    )}
                    {c.canMove && (
                      <label className="mt-2 block text-xs text-graphite">
                        <span className="sr-only">Move “{c.title}” to</span>
                        <select className="input py-1 text-xs" value={statusOf(c)} onChange={(e) => move(c.id, e.target.value)} disabled={pending}>
                          {COLUMNS.map((o) => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                          ))}
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
