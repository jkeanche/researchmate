import { fromDay, toDay } from "./dates";

/**
 * Scheduling engine: pure functions over tasks and dependencies.
 *
 * Model
 * -----
 * Every item is converted to a half-open day interval [s, f):
 *   task       s = start,     f = end + 1      (duration f - s >= 1)
 *   milestone  s = f = date + 1                 (a point at the end of its day)
 * Treating a milestone as the end of its day makes "milestone after task"
 * (finish-to-start) land on the task's last day, and "task after milestone"
 * start the next day — what people expect.
 *
 * Dependency constraints on a successor with duration d:
 *   FS  succ.s >= pred.f + lag
 *   SS  succ.s >= pred.s + lag
 *   FF  succ.f >= pred.f + lag
 *   SF  succ.f >= pred.s + lag
 *
 * Summary tasks (tasks with children) take their dates from their children.
 * Moving a summary moves its whole subtree. Dependencies may connect any two
 * items except an item and its own ancestor or descendant.
 */

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface PlanTask {
  id: string;
  parentId: string | null;
  kind: "task" | "milestone";
  title: string;
  startDate: string;
  endDate: string;
  status: string;
  progressPercent: number;
  deadlineLocked?: boolean;
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  sortOrder?: number;
}

export interface PlanDependency {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export const DEPENDENCY_LABELS: Record<DependencyType, string> = {
  FS: "finish-to-start",
  SS: "start-to-start",
  FF: "finish-to-finish",
  SF: "start-to-finish",
};

export class PlanningError extends Error {
  constructor(
    readonly code: "CYCLE" | "HIERARCHY" | "CONSTRAINT" | "LOCKED" | "INVALID",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Interval {
  s: number;
  f: number;
}

export function intervalOf(t: Pick<PlanTask, "kind" | "startDate" | "endDate">): Interval {
  if (t.kind === "milestone") {
    const p = toDay(t.startDate) + 1;
    return { s: p, f: p };
  }
  return { s: toDay(t.startDate), f: toDay(t.endDate) + 1 };
}

function datesOf(kind: PlanTask["kind"], iv: Interval): { startDate: string; endDate: string } {
  if (kind === "milestone") {
    const d = fromDay(iv.s - 1);
    return { startDate: d, endDate: d };
  }
  return { startDate: fromDay(iv.s), endDate: fromDay(iv.f - 1) };
}

/** Lowest successor start allowed by one dependency. */
export function minSuccessorStart(dep: Pick<PlanDependency, "type" | "lagDays">, pred: Interval, succDuration: number): number {
  switch (dep.type) {
    case "FS":
      return pred.f + dep.lagDays;
    case "SS":
      return pred.s + dep.lagDays;
    case "FF":
      return pred.f + dep.lagDays - succDuration;
    case "SF":
      return pred.s + dep.lagDays - succDuration;
  }
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export class TaskTree {
  readonly byId = new Map<string, PlanTask>();
  readonly children = new Map<string, string[]>();
  readonly roots: string[] = [];

  constructor(tasks: PlanTask[]) {
    for (const t of tasks) this.byId.set(t.id, t);
    const order = (a: string, b: string) => {
      const ta = this.byId.get(a)!;
      const tb = this.byId.get(b)!;
      return (ta.sortOrder ?? 0) - (tb.sortOrder ?? 0) || ta.startDate.localeCompare(tb.startDate) || ta.title.localeCompare(tb.title);
    };
    for (const t of tasks) {
      if (t.parentId && this.byId.has(t.parentId)) {
        if (!this.children.has(t.parentId)) this.children.set(t.parentId, []);
        this.children.get(t.parentId)!.push(t.id);
      } else this.roots.push(t.id);
    }
    for (const list of this.children.values()) list.sort(order);
    this.roots.sort(order);
    // Detect parent cycles (a corrupt hierarchy would otherwise loop forever).
    for (const t of tasks) {
      const seen = new Set<string>();
      let cur: string | null = t.id;
      while (cur) {
        if (seen.has(cur)) throw new PlanningError("HIERARCHY", "The task hierarchy contains a loop.");
        seen.add(cur);
        cur = this.byId.get(cur)?.parentId ?? null;
        if (cur && !this.byId.has(cur)) break;
      }
    }
  }

  isSummary(id: string): boolean {
    return (this.children.get(id)?.length ?? 0) > 0;
  }

  /** The item and all its descendants. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const walk = (x: string) => {
      out.push(x);
      for (const c of this.children.get(x) ?? []) walk(c);
    };
    walk(id);
    return out;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.byId.get(id)?.parentId ?? null;
    while (cur && this.byId.has(cur)) {
      out.push(cur);
      cur = this.byId.get(cur)!.parentId;
    }
    return out;
  }

  isAncestor(a: string, of: string): boolean {
    return this.ancestors(of).includes(a);
  }

  leaves(id: string): string[] {
    return this.subtree(id).filter((x) => !this.isSummary(x));
  }

  /** Depth-first order with outline (WBS) codes: 1, 1.1, 1.2, 2 … */
  outline(): { id: string; depth: number; wbs: string }[] {
    const out: { id: string; depth: number; wbs: string }[] = [];
    const walk = (ids: string[], prefix: string, depth: number) =>
      ids.forEach((id, i) => {
        const wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
        out.push({ id, depth, wbs });
        walk(this.children.get(id) ?? [], wbs, depth + 1);
      });
    walk(this.roots, "", 0);
    return out;
  }
}

/** Checks that `parentId` may become the parent of `taskId`. */
export function validateParent(tasks: PlanTask[], taskId: string | null, parentId: string | null, deps: PlanDependency[] = []): void {
  if (!parentId) return;
  const tree = new TaskTree(tasks);
  const parent = tree.byId.get(parentId);
  if (!parent) throw new PlanningError("INVALID", "The parent task does not exist in this project.");
  if (parent.kind === "milestone") throw new PlanningError("HIERARCHY", "A milestone cannot contain subtasks.");
  if (taskId) {
    if (taskId === parentId || tree.isAncestor(taskId, parentId)) throw new PlanningError("HIERARCHY", "A task cannot be placed inside itself or one of its subtasks.");
    // Re-parenting must not create a dependency between an item and its new ancestor.
    const moved = new Set(tree.subtree(taskId));
    const newAncestors = new Set([parentId, ...tree.ancestors(parentId)]);
    for (const d of deps) {
      if ((moved.has(d.predecessorId) && newAncestors.has(d.successorId)) || (moved.has(d.successorId) && newAncestors.has(d.predecessorId))) {
        throw new PlanningError("HIERARCHY", "That move would put a task inside a task it has a dependency with.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

/**
 * Expanded precedence graph: a dependency X→Y means every item in X's
 * subtree precedes every item in Y's subtree (moving a summary moves its
 * children; a summary's dates come from its children).
 */
function expandedEdges(tree: TaskTree, deps: PlanDependency[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of tree.byId.keys()) out.set(id, new Set());
  for (const d of deps) {
    if (!tree.byId.has(d.predecessorId) || !tree.byId.has(d.successorId)) continue;
    for (const x of tree.subtree(d.predecessorId)) for (const y of tree.subtree(d.successorId)) out.get(x)!.add(y);
  }
  return out;
}

/** Returns one cycle (as task ids) if the graph has any, else null. */
export function findCycle(tasks: PlanTask[], deps: PlanDependency[]): string[] | null {
  const tree = new TaskTree(tasks);
  const edges = expandedEdges(tree, deps);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (n: string): boolean => {
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const st = state.get(m) ?? 0;
      if (st === 1) {
        cycle = stack.slice(stack.indexOf(m));
        return true;
      }
      if (st === 0 && visit(m)) return true;
    }
    stack.pop();
    state.set(n, 2);
    return false;
  };
  for (const n of edges.keys()) if ((state.get(n) ?? 0) === 0 && visit(n)) break;
  return cycle;
}

/** Validates a new dependency against the existing graph. */
export function validateNewDependency(tasks: PlanTask[], deps: PlanDependency[], dep: PlanDependency): void {
  const tree = new TaskTree(tasks);
  const a = tree.byId.get(dep.predecessorId);
  const b = tree.byId.get(dep.successorId);
  if (!a || !b) throw new PlanningError("INVALID", "Both tasks must belong to this project.");
  if (a.id === b.id) throw new PlanningError("INVALID", "A task cannot depend on itself.");
  if (tree.isAncestor(a.id, b.id) || tree.isAncestor(b.id, a.id)) {
    throw new PlanningError("HIERARCHY", "A task cannot depend on its own parent or subtask.");
  }
  if (!Number.isInteger(dep.lagDays) || Math.abs(dep.lagDays) > 365) throw new PlanningError("INVALID", "Lag must be a whole number of days between -365 and 365.");
  if (deps.some((d) => d.predecessorId === dep.predecessorId && d.successorId === dep.successorId)) {
    throw new PlanningError("INVALID", "That dependency already exists.");
  }
  const cycle = findCycle(tasks, [...deps, dep]);
  if (cycle) {
    const names = cycle.map((id) => tree.byId.get(id)?.title ?? id);
    throw new PlanningError("CYCLE", `That dependency would create a loop: ${[...names, names[0]].join(" → ")}.`, { cycle });
  }
}

/** Topological order of all items over the expanded graph (throws on cycles). */
export function topologicalOrder(tasks: PlanTask[], deps: PlanDependency[]): string[] {
  const tree = new TaskTree(tasks);
  const edges = expandedEdges(tree, deps);
  const indeg = new Map<string, number>();
  for (const id of edges.keys()) indeg.set(id, 0);
  for (const outs of edges.values()) for (const m of outs) indeg.set(m, indeg.get(m)! + 1);
  const outline = tree.outline().map((o) => o.id);
  const queue = outline.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of edges.get(n)!) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length !== edges.size) throw new PlanningError("CYCLE", "The schedule contains a dependency loop.");
  return order;
}

// ---------------------------------------------------------------------------
// Roll-up, violations and cascading
// ---------------------------------------------------------------------------

export interface DateChange {
  id: string;
  title: string;
  oldStartDate: string;
  oldEndDate: string;
  startDate: string;
  endDate: string;
  reason: "edit" | "cascade" | "rollup";
}

/** Summary dates = span of children; returns tasks with rolled-up dates. */
export function rollUp(tasks: PlanTask[]): PlanTask[] {
  const tree = new TaskTree(tasks);
  const result = new Map(tasks.map((t) => [t.id, { ...t }]));
  const visit = (id: string): Interval => {
    const t = result.get(id)!;
    const kids = tree.children.get(id) ?? [];
    if (!kids.length) return intervalOf(t);
    const ivs = kids.map(visit);
    // A summary is always a span of days, even if it only contains milestones.
    const s = Math.min(...ivs.map((i) => (i.s === i.f ? i.s - 1 : i.s)));
    const f = Math.max(...ivs.map((i) => i.f));
    Object.assign(t, datesOf("task", { s, f: Math.max(f, s + 1) }));
    return intervalOf(t);
  };
  for (const r of tree.roots) visit(r);
  return tasks.map((t) => result.get(t.id)!);
}

export interface Violation {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  /** Days the successor would need to move later to satisfy the dependency. */
  shortfallDays: number;
}

export function findViolations(tasks: PlanTask[], deps: PlanDependency[]): Violation[] {
  const byId = new Map(rollUp(tasks).map((t) => [t.id, t]));
  const out: Violation[] = [];
  for (const d of deps) {
    const p = byId.get(d.predecessorId);
    const s = byId.get(d.successorId);
    if (!p || !s) continue;
    const si = intervalOf(s);
    const bound = minSuccessorStart(d, intervalOf(p), si.f - si.s);
    if (si.s < bound) out.push({ ...d, shortfallDays: bound - si.s });
  }
  return out;
}

export interface RescheduleResult {
  tasks: PlanTask[];
  changes: DateChange[];
}

export interface RescheduleOptions {
  /** Allow moving tasks whose deadline is locked (an approver confirmed it). */
  allowLockedChanges?: boolean;
}

/**
 * Applies date edits and pushes dependent items later as needed so every
 * dependency holds. Items are never pulled earlier automatically.
 *
 * Rejects (PlanningError) when:
 * - an edited item would start before its own predecessors allow,
 * - a summary task is resized (its dates come from its children),
 * - a cascade would move a locked deadline without allowLockedChanges.
 */
export function reschedule(
  tasks: PlanTask[],
  deps: PlanDependency[],
  edits: { id: string; startDate: string; endDate: string }[],
  opts: RescheduleOptions = {},
): RescheduleResult {
  const tree = new TaskTree(tasks);
  // Rolled-up dates are what users see (used to interpret edits to summaries);
  // stored dates are what changes are reported against, so stale summary dates get saved.
  const original = new Map(rollUp(tasks).map((t) => [t.id, t]));
  const stored = new Map(tasks.map((t) => [t.id, t]));
  const cur = new Map(tasks.map((t) => [t.id, { ...t }]));
  const edited = new Set<string>();

  const shiftSubtree = (id: string, delta: number) => {
    for (const x of tree.subtree(id)) {
      const t = cur.get(x)!;
      const iv = intervalOf(t);
      Object.assign(t, datesOf(t.kind, { s: iv.s + delta, f: iv.f + delta }));
    }
  };

  for (const e of edits) {
    const t = cur.get(e.id);
    if (!t) throw new PlanningError("INVALID", "Task not found.");
    if (e.endDate < e.startDate) throw new PlanningError("INVALID", "The end date must be on or after the start date.");
    if (t.kind === "milestone" && e.endDate !== e.startDate) throw new PlanningError("INVALID", "A milestone has a single date.");
    const before = original.get(e.id)!;
    if (tree.isSummary(e.id)) {
      const delta = toDay(e.startDate) - toDay(before.startDate);
      if (toDay(e.endDate) - toDay(before.endDate) !== delta) {
        throw new PlanningError("INVALID", `"${t.title}" takes its dates from its subtasks. Move it as a whole, or change the subtasks.`);
      }
      shiftSubtree(e.id, delta);
    } else {
      t.startDate = e.startDate;
      t.endDate = e.endDate;
    }
    edited.add(e.id);
  }

  // Edited items must satisfy their incoming dependencies as entered.
  {
    const rolled = new Map(rollUp([...cur.values()]).map((t) => [t.id, t]));
    for (const d of deps) {
      if (!edited.has(d.successorId)) continue;
      const p = rolled.get(d.predecessorId);
      const s = rolled.get(d.successorId);
      if (!p || !s) continue;
      const si = intervalOf(s);
      const bound = minSuccessorStart(d, intervalOf(p), si.f - si.s);
      if (si.s < bound && !edited.has(d.predecessorId)) {
        const earliest = datesOf(s.kind, { s: bound, f: bound + (si.f - si.s) }).startDate;
        throw new PlanningError(
          "CONSTRAINT",
          `"${s.title}" can't start before ${earliest}: it has a ${DEPENDENCY_LABELS[d.type]} dependency on "${p.title}"${d.lagDays ? ` with ${d.lagDays} day(s) lag` : ""}.`,
          { predecessorId: p.id, successorId: s.id, earliestStart: earliest },
        );
      }
    }
  }

  // Push successors forward until stable. Forward-only shifts over a DAG terminate.
  const order = topologicalOrder(tasks, deps);
  const rank = new Map(order.map((id, i) => [id, i]));
  const sortedDeps = [...deps].sort((a, b) => (rank.get(a.successorId) ?? 0) - (rank.get(b.successorId) ?? 0));
  const maxPasses = tasks.length + 2;
  for (let pass = 0; ; pass++) {
    if (pass > maxPasses) throw new PlanningError("CYCLE", "The schedule could not be resolved.");
    let changed = false;
    let rolled = new Map(rollUp([...cur.values()]).map((t) => [t.id, t]));
    for (const d of sortedDeps) {
      const p = rolled.get(d.predecessorId);
      const s = rolled.get(d.successorId);
      if (!p || !s) continue;
      const si = intervalOf(s);
      const bound = minSuccessorStart(d, intervalOf(p), si.f - si.s);
      if (si.s < bound) {
        shiftSubtree(d.successorId, bound - si.s);
        changed = true;
        rolled = new Map(rollUp([...cur.values()]).map((t) => [t.id, t])); // summaries may have moved
      }
    }
    if (!changed) break;
  }

  const final = rollUp([...cur.values()]);
  const changes: DateChange[] = [];
  for (const t of final) {
    const o = stored.get(t.id)!;
    if (o.startDate === t.startDate && o.endDate === t.endDate) continue;
    const reason = edited.has(t.id) ? "edit" : tree.isSummary(t.id) ? "rollup" : "cascade";
    changes.push({ id: t.id, title: t.title, oldStartDate: o.startDate, oldEndDate: o.endDate, startDate: t.startDate, endDate: t.endDate, reason });
  }

  if (!opts.allowLockedChanges) {
    const blocked = changes.filter((c) => c.reason !== "rollup" && tree.byId.get(c.id)!.deadlineLocked && c.oldEndDate !== c.endDate);
    if (blocked.length) {
      throw new PlanningError(
        "LOCKED",
        `This change would move an approved deadline: ${blocked.map((b) => `"${b.title}" (${b.oldEndDate} → ${b.endDate})`).join(", ")}. An approver must confirm it.`,
        { taskIds: blocked.map((b) => b.id) },
      );
    }
  }
  return { tasks: final, changes };
}

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

export interface CriticalPathResult {
  /** Total float in days per item (summaries: minimum of their leaves). */
  floatDays: Map<string, number>;
  critical: Set<string>;
  projectFinish: string | null;
}

/**
 * Critical path method over the current schedule. Forward dates are the
 * planned dates (the schedule is kept feasible); the backward pass computes
 * latest finishes from the project finish. Items with zero float are
 * critical. Cancelled items are ignored.
 */
export function criticalPath(tasksIn: PlanTask[], depsIn: PlanDependency[]): CriticalPathResult {
  const tasks = rollUp(tasksIn.filter((t) => t.status !== "cancelled"));
  const ids = new Set(tasks.map((t) => t.id));
  const tree = new TaskTree(tasks);
  const deps = depsIn.filter((d) => ids.has(d.predecessorId) && ids.has(d.successorId));
  const leaves = tasks.filter((t) => !tree.isSummary(t.id));
  const floatDays = new Map<string, number>();
  if (!leaves.length) return { floatDays, critical: new Set(), projectFinish: null };

  const iv = new Map(leaves.map((t) => [t.id, intervalOf(t)]));
  const pf = Math.max(...[...iv.values()].map((i) => i.f));

  // Expand summary endpoints to the leaves that drive the relevant date.
  const drivers = (id: string, end: "s" | "f"): string[] => {
    const ls = tree.leaves(id).filter((x) => iv.has(x));
    if (!ls.length) return [];
    const target = end === "s" ? Math.min(...ls.map((x) => iv.get(x)!.s)) : Math.max(...ls.map((x) => iv.get(x)!.f));
    return ls.filter((x) => iv.get(x)![end] === target);
  };
  const leafDeps: PlanDependency[] = [];
  for (const d of deps) {
    const predEnd = d.type === "FS" || d.type === "FF" ? "f" : "s";
    const succEnd = d.type === "FS" || d.type === "SS" ? "s" : "f";
    for (const p of drivers(d.predecessorId, predEnd)) for (const s of drivers(d.successorId, succEnd)) leafDeps.push({ ...d, predecessorId: p, successorId: s });
  }

  const order = topologicalOrder(leaves.map((l) => ({ ...l, parentId: null })), leafDeps);
  const lf = new Map<string, number>();
  const outgoing = new Map<string, PlanDependency[]>();
  for (const d of leafDeps) {
    if (!outgoing.has(d.predecessorId)) outgoing.set(d.predecessorId, []);
    outgoing.get(d.predecessorId)!.push(d);
  }
  for (const id of [...order].reverse()) {
    const i = iv.get(id)!;
    const d = i.f - i.s;
    let latest = pf;
    for (const dep of outgoing.get(id) ?? []) {
      const sLf = lf.get(dep.successorId)!;
      const sIv = iv.get(dep.successorId)!;
      const sLs = sLf - (sIv.f - sIv.s);
      const bound =
        dep.type === "FS" ? sLs - dep.lagDays : dep.type === "SS" ? sLs - dep.lagDays + d : dep.type === "FF" ? sLf - dep.lagDays : sLf - dep.lagDays + d;
      latest = Math.min(latest, bound);
    }
    lf.set(id, latest);
    floatDays.set(id, latest - i.f);
  }
  for (const t of tasks) {
    if (!tree.isSummary(t.id)) continue;
    const fl = tree.leaves(t.id).map((x) => floatDays.get(x)).filter((x): x is number => x !== undefined);
    if (fl.length) floatDays.set(t.id, Math.min(...fl));
  }
  const critical = new Set([...floatDays].filter(([, f]) => f <= 0).map(([id]) => id));
  return { floatDays, critical, projectFinish: fromDay(pf - 1) };
}

// ---------------------------------------------------------------------------
// Status, forecast, variance, progress
// ---------------------------------------------------------------------------

const CLOSED = new Set(["done", "cancelled"]);

export function isOverdue(t: Pick<PlanTask, "status" | "endDate">, today: string): boolean {
  return !CLOSED.has(t.status) && t.endDate < today;
}

export function isLateStart(t: Pick<PlanTask, "status" | "startDate" | "progressPercent" | "actualStartDate">, today: string): boolean {
  return t.status === "todo" && !t.actualStartDate && t.progressPercent === 0 && t.startDate < today;
}

export interface Forecast {
  /** Forecast dates per leaf item. */
  dates: Map<string, { startDate: string; endDate: string }>;
  estimatedCompletion: string | null;
}

/**
 * Forecast from today: unfinished work cannot happen in the past, and late
 * predecessors push their successors. Remaining duration for in-progress
 * work is proportional to its outstanding progress.
 */
export function forecast(tasksIn: PlanTask[], depsIn: PlanDependency[], today: string): Forecast {
  const tasks = rollUp(tasksIn.filter((t) => t.status !== "cancelled"));
  const ids = new Set(tasks.map((t) => t.id));
  const deps = depsIn.filter((d) => ids.has(d.predecessorId) && ids.has(d.successorId));
  const tree = new TaskTree(tasks);
  const t0 = toDay(today);
  const order = topologicalOrder(tasks, deps);
  const fc = new Map<string, Interval>();
  const incoming = new Map<string, PlanDependency[]>();
  for (const d of deps) {
    if (!incoming.has(d.successorId)) incoming.set(d.successorId, []);
    incoming.get(d.successorId)!.push(d);
  }
  // Summaries' incoming dependencies constrain all their descendants.
  const constraintsFor = (id: string) => [id, ...tree.ancestors(id)].flatMap((x) => incoming.get(x) ?? []);
  const spanOf = (id: string): Interval | undefined => {
    if (!tree.isSummary(id)) return fc.get(id);
    const ls = tree.leaves(id).map((x) => fc.get(x)).filter((x): x is Interval => !!x);
    if (!ls.length) return undefined;
    return { s: Math.min(...ls.map((x) => x.s)), f: Math.max(...ls.map((x) => x.f)) };
  };

  for (const id of order) {
    if (tree.isSummary(id)) continue;
    const t = tree.byId.get(id)!;
    const planned = intervalOf(t);
    const d = planned.f - planned.s;
    if (t.status === "done") {
      const s = t.actualStartDate ? intervalOf({ kind: t.kind, startDate: t.actualStartDate, endDate: t.actualStartDate }).s : planned.s;
      const f = t.actualEndDate ? intervalOf({ kind: t.kind, startDate: t.actualEndDate, endDate: t.actualEndDate }).f : planned.f;
      fc.set(id, { s, f: Math.max(f, s) });
      continue;
    }
    let lb = -Infinity;
    for (const dep of constraintsFor(id)) {
      const p = spanOf(dep.predecessorId);
      if (p) lb = Math.max(lb, minSuccessorStart(dep, p, d));
    }
    const started = t.status === "in_progress" || t.status === "in_review" || t.progressPercent > 0 || !!t.actualStartDate;
    const nowPoint = t.kind === "milestone" ? t0 + 1 : t0;
    if (started) {
      const s = t.actualStartDate ? toDay(t.actualStartDate) : planned.s;
      const remaining = Math.ceil(d * (1 - t.progressPercent / 100));
      const f = Math.max(planned.f, t0 + remaining, lb + d);
      fc.set(id, { s: Math.min(s, f - Math.max(d, 1)), f });
    } else {
      const s = Math.max(planned.s, nowPoint, lb);
      fc.set(id, { s, f: s + d });
    }
  }
  const dates = new Map<string, { startDate: string; endDate: string }>();
  for (const [id, i] of fc) dates.set(id, datesOf(tree.byId.get(id)!.kind, i));
  const fs = [...fc.values()].map((i) => i.f);
  return { dates, estimatedCompletion: fs.length ? fromDay(Math.max(...fs) - 1) : null };
}

export interface BaselineItem {
  taskId: string;
  kind: string;
  title: string;
  startDate: string;
  endDate: string;
}

export interface VarianceRow {
  taskId: string;
  title: string;
  kind: string;
  baselineStart: string;
  baselineEnd: string;
  currentStart: string | null;
  currentEnd: string | null;
  /** Positive = later than baseline. */
  startVarianceDays: number | null;
  finishVarianceDays: number | null;
  removed: boolean;
}

export function scheduleVariance(tasks: PlanTask[], baseline: BaselineItem[]): { rows: VarianceRow[]; added: string[] } {
  const cur = new Map(rollUp(tasks).map((t) => [t.id, t]));
  const rows = baseline.map((b) => {
    const c = cur.get(b.taskId);
    return {
      taskId: b.taskId,
      title: c?.title ?? b.title,
      kind: b.kind,
      baselineStart: b.startDate,
      baselineEnd: b.endDate,
      currentStart: c?.startDate ?? null,
      currentEnd: c?.endDate ?? null,
      startVarianceDays: c ? toDay(c.startDate) - toDay(b.startDate) : null,
      finishVarianceDays: c ? toDay(c.endDate) - toDay(b.endDate) : null,
      removed: !c,
    };
  });
  const inBaseline = new Set(baseline.map((b) => b.taskId));
  return { rows, added: tasks.filter((t) => !inBaseline.has(t.id)).map((t) => t.id) };
}

/**
 * Duration-weighted progress of leaf tasks (done = 100%). Milestones only
 * count when a plan has nothing else. Cancelled items are excluded.
 */
export function weightedProgress(tasksIn: PlanTask[]): number {
  const tree = new TaskTree(tasksIn);
  const leaves = tasksIn.filter((t) => !tree.isSummary(t.id) && t.status !== "cancelled");
  const work = leaves.filter((t) => t.kind === "task");
  const pool = work.length ? work : leaves;
  if (!pool.length) return 0;
  let w = 0;
  let acc = 0;
  for (const t of pool) {
    const weight = t.kind === "milestone" ? 1 : Math.max(1, toDay(t.endDate) - toDay(t.startDate) + 1);
    const p = t.status === "done" ? 100 : Math.max(0, Math.min(100, t.progressPercent));
    w += weight;
    acc += weight * p;
  }
  return Math.round(acc / w);
}

/** Progress of each summary task, from its leaves. */
export function summaryProgress(tasks: PlanTask[]): Map<string, number> {
  const tree = new TaskTree(tasks);
  const out = new Map<string, number>();
  for (const t of tasks) if (tree.isSummary(t.id)) out.set(t.id, weightedProgress(tree.subtree(t.id).map((x) => tree.byId.get(x)!)));
  return out;
}
