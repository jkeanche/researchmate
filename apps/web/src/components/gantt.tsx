"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ganttMoveAction, type PlanActionResult } from "@/server/actions/planning";

export interface GanttTask {
  id: string;
  wbs: string;
  depth: number;
  title: string;
  kind: "task" | "milestone";
  isSummary: boolean;
  startDate: string;
  endDate: string;
  progress: number;
  status: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  stageId: string | null;
  stageName: string | null;
  critical: boolean;
  overdue: boolean;
  locked: boolean;
  version: number;
  forecastEnd: string | null;
}
export interface GanttDep {
  id: string;
  predecessorId: string;
  successorId: string;
  type: "FS" | "SS" | "FF" | "SF";
  lagDays: number;
}
export interface GanttBaseline {
  id: string;
  name: string;
  items: { taskId: string; startDate: string; endDate: string; kind: string }[];
}

type Scale = "day" | "week" | "month" | "quarter";
const DAY_W: Record<Scale, number> = { day: 28, week: 11, month: 3.6, quarter: 1.4 };
const ROW = 34;
const HEAD = 46;
const LABEL_W = 300;
const DAY = 86_400_000;
// Resolved colours (SVG is exported standalone, so CSS variables can't be used).
const C = {
  ink: "#1b2a3a",
  graphite: "#56636f",
  rule: "#cad6e2",
  soft: "#e3eaf1",
  paper: "#f6f7f5",
  sheet: "#ffffff",
  green: "#2f6b4f",
  greenWash: "#cfe0d6",
  red: "#b23a3a",
  amber: "#8a5a12",
  baseline: "#9aa8b6",
  weekend: "#f0f3f6",
};
const FONT = '"Public Sans Variable", ui-sans-serif, system-ui, sans-serif';

const toDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const weekday = (n: number) => (n + 4) % 7; // 0 = Sunday
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Half-open day interval; milestones are a point at the end of their day. */
function interval(t: { kind: string; startDate: string; endDate: string }) {
  if (t.kind === "milestone") {
    const p = toDay(t.startDate) + 1;
    return { s: p, f: p };
  }
  return { s: toDay(t.startDate), f: toDay(t.endDate) + 1 };
}

function ticks(scale: Scale, from: number, to: number) {
  const top: { x0: number; x1: number; label: string }[] = [];
  const bottom: { x0: number; x1: number; label: string; weekend?: boolean }[] = [];
  const ymd = (n: number) => {
    const d = new Date(n * DAY);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  };
  const monthStart = (y: number, m: number) => Math.round(Date.UTC(y, m, 1) / DAY);
  // Top row: months (day/week scales) or years (month/quarter scales).
  if (scale === "day" || scale === "week") {
    let { y, m } = ymd(from);
    for (let s = monthStart(y, m); s < to; ) {
      const e = monthStart(m === 11 ? y + 1 : y, (m + 1) % 12);
      top.push({ x0: Math.max(s, from), x1: Math.min(e, to), label: `${MONTHS[m]} ${y}` });
      s = e;
      m = (m + 1) % 12;
      if (m === 0) y++;
    }
  } else {
    for (let y = ymd(from).y; monthStart(y, 0) < to; y++) top.push({ x0: Math.max(monthStart(y, 0), from), x1: Math.min(monthStart(y + 1, 0), to), label: String(y) });
  }
  if (scale === "day") {
    for (let n = from; n < to; n++) bottom.push({ x0: n, x1: n + 1, label: String(ymd(n).d), weekend: weekday(n) === 0 || weekday(n) === 6 });
  } else if (scale === "week") {
    let n = from - ((weekday(from) + 6) % 7); // Monday
    for (; n < to; n += 7) bottom.push({ x0: Math.max(n, from), x1: Math.min(n + 7, to), label: String(ymd(n).d) });
  } else if (scale === "month") {
    let { y, m } = ymd(from);
    for (let s = monthStart(y, m); s < to; ) {
      const e = monthStart(m === 11 ? y + 1 : y, (m + 1) % 12);
      bottom.push({ x0: Math.max(s, from), x1: Math.min(e, to), label: MONTHS[m]! });
      s = e;
      m = (m + 1) % 12;
      if (m === 0) y++;
    }
  } else {
    let { y, m } = ymd(from);
    m = m - (m % 3);
    for (let s = monthStart(y, m); s < to; ) {
      const nm = m + 3;
      const e = nm >= 12 ? monthStart(y + 1, nm - 12) : monthStart(y, nm);
      bottom.push({ x0: Math.max(s, from), x1: Math.min(e, to), label: `Q${m / 3 + 1}` });
      s = e;
      m = nm % 12;
      if (nm >= 12) y++;
    }
  }
  return { top, bottom };
}

interface Drag {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  orig: { s: number; f: number };
  delta: number;
}

export function GanttChart({
  tasks,
  deps,
  baselines,
  today,
  canEdit,
  canApprove,
  readOnlyReason,
  projectId,
}: {
  tasks: GanttTask[];
  deps: GanttDep[];
  baselines: GanttBaseline[];
  today: string;
  canEdit: boolean;
  canApprove: boolean;
  readOnlyReason?: string | null;
  projectId: string;
}) {
  const router = useRouter();
  const [scale, setScale] = useState<Scale>("week");
  const [baselineId, setBaselineId] = useState(baselines[0]?.id ?? "");
  const [showCritical, setShowCritical] = useState(true);
  const [fStatus, setFStatus] = useState("");
  const [fOwner, setFOwner] = useState("");
  const [fStage, setFStage] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Record<string, { startDate: string; endDate: string }>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [lockedPrompt, setLockedPrompt] = useState<{ id: string; startDate: string; endDate: string; version: number; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [printSvg, setPrintSvg] = useState<string | null>(null);
  const labelsRef = useRef<SVGSVGElement>(null);
  const chartRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // New server data supersedes any optimistic positions.
  useEffect(() => setDraft({}), [tasks]);

  const owners = useMemo(() => [...new Map(tasks.filter((t) => t.assigneeUserId).map((t) => [t.assigneeUserId!, t.assigneeName ?? "—"])).entries()], [tasks]);
  const stages = useMemo(() => [...new Map(tasks.filter((t) => t.stageId).map((t) => [t.stageId!, t.stageName ?? "—"])).entries()], [tasks]);
  const visible = tasks.filter(
    (t) => (!fStatus || (fStatus === "open" ? t.status !== "done" && t.status !== "cancelled" : t.status === fStatus)) && (!fOwner || t.assigneeUserId === fOwner) && (!fStage || t.stageId === fStage),
  );
  const shown = visible.map((t) => ({ ...t, ...(draft[t.id] ?? {}) }));
  const baseline = new Map((baselines.find((b) => b.id === baselineId)?.items ?? []).map((i) => [i.taskId, i]));

  const dw = DAY_W[scale];
  const t0 = toDay(today);
  const allDays = [t0, ...shown.flatMap((t) => [interval(t).s, interval(t).f, t.forecastEnd ? toDay(t.forecastEnd) + 1 : 0].filter(Boolean)), ...[...baseline.values()].flatMap((b) => [toDay(b.startDate), toDay(b.endDate) + 1])];
  const pad = scale === "day" ? 3 : scale === "week" ? 7 : scale === "month" ? 15 : 30;
  const from = Math.min(...allDays) - pad;
  const to = Math.max(...allDays, from + 60) + pad * 2;
  const width = Math.round((to - from) * dw);
  const height = HEAD + Math.max(shown.length, 1) * ROW;
  const x = (day: number) => (day - from) * dw;
  const tk = ticks(scale, from, to);
  const rowOf = new Map(shown.map((t, i) => [t.id, i]));
  const byId = new Map(shown.map((t) => [t.id, t]));

  // Scroll so today is in view on first render and on zoom change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, x(t0) - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  function commit(id: string, startDate: string, endDate: string, version: number, confirmLocked = false) {
    setDraft((d) => ({ ...d, [id]: { startDate, endDate } }));
    setMsg(null);
    startTransition(async () => {
      const r: PlanActionResult = await ganttMoveAction({ taskId: id, startDate, endDate, version, confirmLocked, reason: confirmLocked ? reason : undefined });
      if (r.ok) {
        const others = r.changes.filter((c) => c.id !== id && c.reason !== "rollup");
        setMsg({ tone: "ok", text: others.length ? `Saved. Also moved to keep dependencies valid: ${others.map((c) => `“${c.title}” (${c.startDate})`).join(", ")}.` : "Saved." });
        setLockedPrompt(null);
        setReason("");
        router.refresh();
      } else {
        setDraft((d) => {
          const { [id]: _, ...rest } = d;
          return rest;
        });
        if (r.locked && canApprove) setLockedPrompt({ id, startDate, endDate, version, text: r.error });
        else setMsg({ tone: "err", text: r.error });
        if (r.code === "CONFLICT" && !r.locked) router.refresh();
      }
    });
  }

  function applyDelta(t: GanttTask, mode: Drag["mode"], delta: number) {
    const iv = interval(t);
    if (t.kind === "milestone") {
      const d = fromDay(iv.s - 1 + delta);
      return { startDate: d, endDate: d };
    }
    let s = iv.s;
    let f = iv.f;
    if (mode === "move") {
      s += delta;
      f += delta;
    } else if (mode === "start") s = Math.min(s + delta, f - 1);
    else f = Math.max(f + delta, s + 1);
    return { startDate: fromDay(s), endDate: fromDay(f - 1) };
  }

  function onPointerDown(e: React.PointerEvent, t: GanttTask, mode: Drag["mode"]) {
    if (!canEdit || pending) return;
    if (t.isSummary && mode !== "move") return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, mode: t.kind === "milestone" ? "move" : mode, x0: e.clientX, orig: interval(t), delta: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / dw);
    if (delta !== drag.delta) {
      setDrag({ ...drag, delta });
      const t = tasks.find((x) => x.id === drag.id)!;
      setDraft((d) => ({ ...d, [drag.id]: applyDelta(t, drag.mode, delta) }));
    }
  }
  function onPointerUp() {
    if (!drag) return;
    const t = tasks.find((x) => x.id === drag.id)!;
    const d = drag;
    setDrag(null);
    if (d.delta === 0) {
      setDraft((cur) => {
        const { [d.id]: _, ...rest } = cur;
        return rest;
      });
      return;
    }
    const next = applyDelta(t, d.mode, d.delta);
    commit(t.id, next.startDate, next.endDate, t.version);
  }
  function onKey(e: React.KeyboardEvent, t: GanttTask) {
    if (!canEdit || pending || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -1 : 1;
    const mode = e.shiftKey && t.kind === "task" && !t.isSummary ? "end" : "move";
    const next = applyDelta(t, mode, delta);
    commit(t.id, next.startDate, next.endDate, t.version);
  }

  function combinedSvg(): string {
    const lab = labelsRef.current;
    const ch = chartRef.current;
    if (!lab || !ch) return "";
    const w = LABEL_W + width;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" font-family='${FONT}'><rect width="${w}" height="${height}" fill="${C.sheet}"/>${lab.innerHTML}<g transform="translate(${LABEL_W},0)">${ch.innerHTML}</g></svg>`;
  }
  function download(name: string, href: string) {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  }
  function exportSvg() {
    const url = URL.createObjectURL(new Blob([combinedSvg()], { type: "image/svg+xml" }));
    download("gantt.svg", url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportPng() {
    const svg = combinedSvg();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const k = 2;
      const canvas = document.createElement("canvas");
      canvas.width = (LABEL_W + width) * k;
      canvas.height = height * k;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        download("gantt.png", u);
        setTimeout(() => URL.revokeObjectURL(u), 2000);
      }, "image/png");
    };
    img.src = url;
  }
  function printChart() {
    setPrintSvg(combinedSvg());
    setTimeout(() => window.print(), 50);
  }

  const depPath = (d: GanttDep) => {
    const p = byId.get(d.predecessorId);
    const s = byId.get(d.successorId);
    if (!p || !s) return null;
    const pi = interval(p);
    const si = interval(s);
    const py = HEAD + rowOf.get(p.id)! * ROW + ROW / 2;
    const sy = HEAD + rowOf.get(s.id)! * ROW + ROW / 2;
    const x1 = x(d.type === "FS" || d.type === "FF" ? pi.f : pi.s);
    const x2 = x(d.type === "FS" || d.type === "SS" ? si.s : si.f);
    const intoStart = d.type === "FS" || d.type === "SS";
    const out = d.type === "FS" || d.type === "FF" ? 8 : -8;
    const ax = x1 + out;
    const entry = intoStart ? x2 - 8 : x2 + 8;
    const simple = intoStart ? entry >= ax : entry <= ax;
    const midY = sy > py ? HEAD + rowOf.get(s.id)! * ROW : HEAD + (rowOf.get(s.id)! + 1) * ROW;
    const pts = simple ? [[x1, py], [ax, py], [ax, sy], [x2, sy]] : [[x1, py], [ax, py], [ax, midY], [entry, midY], [entry, sy], [x2, sy]];
    return pts.map(([a, b], i) => `${i ? "L" : "M"}${a!.toFixed(1)},${b!.toFixed(1)}`).join(" ");
  };

  const critOn = showCritical;

  return (
    <div className="grid gap-3">
      <div className="no-print flex flex-wrap items-end gap-x-4 gap-y-2 text-sm">
        <div className="field">
          <label htmlFor="g-scale">Zoom</label>
          <select id="g-scale" className="input py-1.5" value={scale} onChange={(e) => setScale(e.target.value as Scale)}>
            <option value="day">Days</option>
            <option value="week">Weeks</option>
            <option value="month">Months</option>
            <option value="quarter">Quarters</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="g-status">Status</label>
          <select id="g-status" className="input py-1.5" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">All</option>
            <option value="open">Not done</option>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="in_review">In review</option>
            <option value="done">Done</option>
          </select>
        </div>
        {owners.length > 0 && (
          <div className="field">
            <label htmlFor="g-owner">Owner</label>
            <select id="g-owner" className="input py-1.5" value={fOwner} onChange={(e) => setFOwner(e.target.value)}>
              <option value="">Everyone</option>
              {owners.map(([id, n]) => (
                <option key={id} value={id}>{n}</option>
              ))}
            </select>
          </div>
        )}
        {stages.length > 0 && (
          <div className="field">
            <label htmlFor="g-stage">Stage</label>
            <select id="g-stage" className="input max-w-48 py-1.5" value={fStage} onChange={(e) => setFStage(e.target.value)}>
              <option value="">All stages</option>
              {stages.map(([id, n]) => (
                <option key={id} value={id}>{n}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="g-baseline">Baseline</label>
          <select id="g-baseline" className="input py-1.5" value={baselineId} onChange={(e) => setBaselineId(e.target.value)} disabled={!baselines.length}>
            <option value="">{baselines.length ? "Hide" : "None saved"}</option>
            {baselines.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} /> Critical path
        </label>
        <div className="ml-auto flex gap-2 pb-0.5">
          <button type="button" className="btn btn-quiet px-3 py-1.5 text-sm" onClick={exportPng}>PNG</button>
          <button type="button" className="btn btn-quiet px-3 py-1.5 text-sm" onClick={exportSvg}>SVG</button>
          <button type="button" className="btn btn-quiet px-3 py-1.5 text-sm" onClick={printChart}>Print / PDF</button>
        </div>
      </div>

      {readOnlyReason ? <p className="no-print text-sm text-graphite">{readOnlyReason}</p> : canEdit ? (
        <p className="no-print text-sm text-graphite">Drag a bar to move it, drag its ends to change dates. With a bar focused, ← → move it a day, Shift+← → change its length. Every change is checked on the server.</p>
      ) : null}

      <div aria-live="polite" className="no-print">
        {pending && <p className="text-sm text-graphite">Saving…</p>}
        {msg && <p role={msg.tone === "err" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${msg.tone === "err" ? "border-margin/30 bg-margin-wash text-margin" : "border-green/30 bg-green-wash text-green-dark"}`}>{msg.text}</p>}
      </div>
      {lockedPrompt && (
        <div role="alertdialog" aria-labelledby="locked-title" className="no-print rounded-md border border-amber/40 bg-amber-wash p-4 text-sm">
          <p id="locked-title" className="font-semibold text-amber">Approved deadline</p>
          <p className="mt-1">{lockedPrompt.text}</p>
          <div className="field mt-3 max-w-md">
            <label htmlFor="locked-reason">Reason (recorded in the schedule history)</label>
            <input id="locked-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn btn-primary" disabled={!reason.trim() || pending} onClick={() => commit(lockedPrompt.id, lockedPrompt.startDate, lockedPrompt.endDate, lockedPrompt.version, true)}>Move the deadline</button>
            <button type="button" className="btn btn-quiet" onClick={() => setLockedPrompt(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="gantt-screen overflow-hidden rounded-md border border-rule bg-sheet">
        <div className="flex">
          <svg ref={labelsRef} width={LABEL_W} height={height} className="shrink-0 border-r border-rule" role="presentation" fontFamily={FONT}>
            <rect width={LABEL_W} height={HEAD} fill={C.paper} />
            <text x={10} y={28} fontSize={12} fontWeight={600} fill={C.graphite}>WBS · Task</text>
            <line x1={0} x2={LABEL_W} y1={HEAD - 0.5} y2={HEAD - 0.5} stroke={C.rule} />
            {shown.map((t, i) => (
              <g key={t.id}>
                {i % 2 === 1 && <rect y={HEAD + i * ROW} width={LABEL_W} height={ROW} fill={C.paper} opacity={0.6} />}
                <text x={10} y={HEAD + i * ROW + 21} fontSize={11} fill={C.graphite}>{t.wbs}</text>
                <text x={44 + t.depth * 14} y={HEAD + i * ROW + 21} fontSize={13} fontWeight={t.isSummary ? 700 : 400} fill={C.ink}>
                  {(t.kind === "milestone" ? "◆ " : "") + (t.title.length > 34 - t.depth * 2 ? `${t.title.slice(0, 32 - t.depth * 2)}…` : t.title)}
                </text>
              </g>
            ))}
          </svg>
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
            <svg
              ref={chartRef}
              width={width}
              height={height}
              fontFamily={FONT}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{ touchAction: drag ? "none" : "pan-x pan-y", userSelect: "none" }}
            >
              <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill={C.graphite} />
                </marker>
                <marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill={C.red} />
                </marker>
              </defs>
              <rect width={width} height={HEAD} fill={C.paper} />
              {tk.bottom.map((b, i) => b.weekend && <rect key={`w${i}`} x={x(b.x0)} y={HEAD} width={(b.x1 - b.x0) * dw} height={height - HEAD} fill={C.weekend} />)}
              {shown.map((t, i) => i % 2 === 1 && <rect key={`z${t.id}`} y={HEAD + i * ROW} width={width} height={ROW} fill={C.paper} opacity={0.5} />)}
              {tk.top.map((b, i) => (
                <g key={`t${i}`}>
                  <line x1={x(b.x0)} x2={x(b.x0)} y1={0} y2={HEAD / 2} stroke={C.rule} />
                  <text x={x(b.x0) + 6} y={16} fontSize={12} fontWeight={600} fill={C.ink}>{(b.x1 - b.x0) * dw > 50 ? b.label : ""}</text>
                </g>
              ))}
              {tk.bottom.map((b, i) => (
                <g key={`b${i}`}>
                  <line x1={x(b.x0)} x2={x(b.x0)} y1={HEAD / 2} y2={height} stroke={C.soft} />
                  <text x={x(b.x0) + ((b.x1 - b.x0) * dw) / 2} y={38} fontSize={11} textAnchor="middle" fill={C.graphite}>{(b.x1 - b.x0) * dw >= 16 ? b.label : ""}</text>
                </g>
              ))}
              <line x1={0} x2={width} y1={HEAD - 0.5} y2={HEAD - 0.5} stroke={C.rule} />

              {/* Baseline */}
              {shown.map((t) => {
                const b = baseline.get(t.id);
                if (!b) return null;
                const bi = interval({ kind: b.kind, startDate: b.startDate, endDate: b.endDate });
                const y = HEAD + rowOf.get(t.id)! * ROW + 26;
                return b.kind === "milestone" ? (
                  <path key={`bl${t.id}`} d={`M${x(bi.s)},${y - 3} l4,4 l-4,4 l-4,-4 z`} fill={C.baseline} />
                ) : (
                  <rect key={`bl${t.id}`} x={x(bi.s)} y={y} width={Math.max(2, (bi.f - bi.s) * dw)} height={4} rx={1} fill={C.baseline}>
                    <title>{`Baseline: ${b.startDate} – ${b.endDate}`}</title>
                  </rect>
                );
              })}

              {/* Dependencies */}
              {deps.map((d) => {
                const path = depPath(d);
                if (!path) return null;
                const crit = critOn && byId.get(d.predecessorId)?.critical && byId.get(d.successorId)?.critical;
                return <path key={d.id} d={path} fill="none" stroke={crit ? C.red : C.graphite} strokeWidth={crit ? 1.6 : 1.1} markerEnd={`url(#${crit ? "arrow-crit" : "arrow"})`} opacity={0.85} />;
              })}

              {/* Bars */}
              {shown.map((t, i) => {
                const iv = interval(t);
                const y = HEAD + i * ROW;
                const crit = critOn && t.critical && t.status !== "done";
                const label = `${t.wbs} ${t.title}: ${t.startDate}${t.kind === "task" ? ` to ${t.endDate}` : ""}, ${t.progress}% complete${t.overdue ? ", overdue" : ""}${t.critical ? ", critical" : ""}${t.locked ? ", approved deadline" : ""}`;
                const common = {
                  tabIndex: 0,
                  role: canEdit ? "button" : "img",
                  "aria-label": label,
                  onKeyDown: (e: React.KeyboardEvent) => onKey(e, t),
                  style: { cursor: canEdit ? (drag?.id === t.id ? "grabbing" : "grab") : "default", outline: "none" },
                  className: "gantt-bar",
                };
                if (t.kind === "milestone") {
                  const cx = x(iv.s);
                  return (
                    <g key={t.id} {...common} onPointerDown={(e) => onPointerDown(e, t, "move")}>
                      <title>{label}</title>
                      <path d={`M${cx},${y + 9} l8,8 l-8,8 l-8,-8 z`} fill={t.status === "done" ? C.ink : crit ? C.red : C.amber} stroke={t.locked ? C.ink : "none"} strokeWidth={1.5} />
                      <text x={cx + 12} y={y + 21} fontSize={11} fill={C.graphite}>{t.startDate.slice(5)}</text>
                    </g>
                  );
                }
                const bx = x(iv.s);
                const bw = Math.max(3, (iv.f - iv.s) * dw);
                if (t.isSummary) {
                  return (
                    <g key={t.id} {...common} onPointerDown={(e) => onPointerDown(e, t, "move")}>
                      <title>{label}</title>
                      <rect x={bx} y={y + 11} width={bw} height={7} fill={crit ? C.red : C.ink} />
                      <rect x={bx} y={y + 11} width={(bw * t.progress) / 100} height={7} fill={C.green} />
                      <path d={`M${bx},${y + 18} l0,6 l6,-6 z M${bx + bw},${y + 18} l0,6 l-6,-6 z`} fill={crit ? C.red : C.ink} />
                    </g>
                  );
                }
                const fcEnd = t.status !== "done" && t.forecastEnd && t.forecastEnd > t.endDate ? toDay(t.forecastEnd) + 1 : null;
                return (
                  <g key={t.id} {...common}>
                    <title>{label}</title>
                    {fcEnd && <rect x={bx + bw} y={y + 8} width={(fcEnd - iv.f) * dw} height={16} fill="none" stroke={C.red} strokeDasharray="3 2" rx={3} opacity={0.7} />}
                    <rect x={bx} y={y + 8} width={bw} height={16} rx={3} fill={t.status === "done" ? C.soft : C.greenWash} stroke={crit ? C.red : t.overdue ? C.red : C.green} strokeWidth={crit ? 2 : 1} onPointerDown={(e) => onPointerDown(e, t, "move")} />
                    <rect x={bx} y={y + 8} width={(bw * t.progress) / 100} height={16} rx={3} fill={t.status === "done" ? C.graphite : C.green} opacity={0.85} pointerEvents="none" />
                    {bw > 44 && <text x={bx + 6} y={y + 20} fontSize={10.5} fontWeight={600} fill={t.progress > 30 ? C.sheet : C.ink} pointerEvents="none">{`${t.progress}%`}</text>}
                    {t.locked && <path d={`M${bx + bw},${y + 4} l0,24`} stroke={C.ink} strokeWidth={2.5} pointerEvents="none" />}
                    {canEdit && (
                      <>
                        <rect x={bx - 3} y={y + 6} width={7} height={20} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onPointerDown(e, t, "start")} />
                        <rect x={bx + bw - 4} y={y + 6} width={7} height={20} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onPointerDown(e, t, "end")} />
                      </>
                    )}
                    {t.assigneeName && bw < 140 && <text x={bx + bw + 6 + (fcEnd ? (fcEnd - iv.f) * dw : 0)} y={y + 20} fontSize={11} fill={C.graphite} pointerEvents="none">{t.assigneeName}</text>}
                  </g>
                );
              })}

              {/* Today */}
              <line x1={x(t0) + dw / 2} x2={x(t0) + dw / 2} y1={HEAD - 6} y2={height} stroke={C.red} strokeWidth={1.5} opacity={0.75} />
              <text x={x(t0) + dw / 2 + 4} y={HEAD - 8} fontSize={10} fontWeight={700} fill={C.red}>Today</text>
            </svg>
          </div>
        </div>
        {!shown.length && <p className="px-4 py-6 text-sm text-graphite">No tasks match these filters.</p>}
      </div>

      <ul className="no-print flex flex-wrap gap-x-5 gap-y-1 text-xs text-graphite" aria-label="Legend">
        <li><span className="mr-1 inline-block h-2.5 w-5 rounded-sm align-middle" style={{ background: C.green }} />Progress</li>
        <li><span className="mr-1 inline-block h-2.5 w-5 rounded-sm border-2 align-middle" style={{ borderColor: C.red }} />Critical path / overdue</li>
        <li><span className="mr-1 inline-block h-1 w-5 align-middle" style={{ background: C.baseline }} />Baseline</li>
        <li><span className="mr-1 inline-block h-2.5 w-5 rounded-sm border border-dashed align-middle" style={{ borderColor: C.red }} />Forecast slip</li>
        <li><span style={{ color: C.amber }}>◆</span> Milestone</li>
        <li><span className="mr-1 inline-block h-3 w-0.5 align-middle" style={{ background: C.ink }} />Approved deadline</li>
      </ul>

      <div className="print-only" aria-hidden dangerouslySetInnerHTML={printSvg ? { __html: printSvg } : undefined} />
      <noscript>
        <p className="text-sm">The interactive chart needs JavaScript. The <Link href={`/app/projects/${projectId}/tasks`}>task list</Link> shows the same schedule.</p>
      </noscript>
    </div>
  );
}
