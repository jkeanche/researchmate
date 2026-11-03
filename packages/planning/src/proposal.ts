import { fromDay, toDay } from "./dates";
import { type DependencyType, minSuccessorStart, PlanningError } from "./engine";

export interface StageInput {
  id: string;
  key: string;
  name: string;
  nominalDurationDays: number;
  dependsOn: { key: string; type: DependencyType; lagDays: number }[];
  milestoneName: string | null;
  include: boolean;
}

export interface ProposalTask {
  ref: string;
  stageId: string | null;
  kind: "task" | "milestone";
  title: string;
  startDate: string;
  endDate: string;
}

export interface ProposalDependency {
  predecessorRef: string;
  successorRef: string;
  type: DependencyType;
  lagDays: number;
}

export interface Proposal {
  tasks: ProposalTask[];
  dependencies: ProposalDependency[];
  assumptions: string[];
  finishDate: string;
}

/**
 * Builds a proposed schedule from workflow stages. Deterministic: the same
 * stages and dates always give the same plan. When a submission date is
 * given, nominal durations (and lags) are scaled so the plan finishes on or
 * before it. Excluded stages are bridged: their successors inherit their
 * predecessors so the sequence stays intact.
 */
export function proposeSchedule(stagesIn: StageInput[], startDate: string, submissionDate: string | null): Proposal {
  if (submissionDate && submissionDate < startDate) throw new PlanningError("INVALID", "The submission date is before the start date.");
  const byKey = new Map(stagesIn.map((s) => [s.key, s]));
  const included = stagesIn.filter((s) => s.include);
  if (!included.length) throw new PlanningError("INVALID", "There are no enabled workflow stages to schedule.");

  // Resolve dependencies through excluded stages.
  const resolveDeps = (s: StageInput, seen = new Set<string>()): { key: string; type: DependencyType; lagDays: number }[] => {
    const out: { key: string; type: DependencyType; lagDays: number }[] = [];
    for (const d of s.dependsOn) {
      const p = byKey.get(d.key);
      if (!p || seen.has(d.key)) continue;
      if (p.include) out.push(d);
      else out.push(...resolveDeps(p, new Set([...seen, d.key])).map((x) => ({ ...x, type: "FS" as const, lagDays: 0 })));
    }
    const uniq = new Map(out.map((d) => [d.key, d]));
    return [...uniq.values()];
  };
  const deps = new Map(included.map((s) => [s.key, resolveDeps(s)]));

  // Topological order (Kahn) over included stages.
  const indeg = new Map(included.map((s) => [s.key, 0]));
  for (const s of included) for (const d of deps.get(s.key)!) if (indeg.has(d.key)) indeg.set(s.key, indeg.get(s.key)! + 1);
  const queue = included.filter((s) => indeg.get(s.key) === 0).map((s) => s.key);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const s of included) {
      if (deps.get(s.key)!.some((d) => d.key === k)) {
        indeg.set(s.key, indeg.get(s.key)! - 1);
        if (indeg.get(s.key) === 0) queue.push(s.key);
      }
    }
  }
  if (order.length !== included.length) throw new PlanningError("CYCLE", "The workflow stages contain a dependency loop.");

  const start = toDay(startDate);
  const build = (scale: number) => {
    const iv = new Map<string, { s: number; f: number }>();
    for (const k of order) {
      const st = byKey.get(k)!;
      const d = Math.max(1, Math.round(st.nominalDurationDays * scale));
      let s = start;
      for (const dep of deps.get(k)!) {
        const p = iv.get(dep.key);
        if (p) s = Math.max(s, minSuccessorStart({ type: dep.type, lagDays: Math.round(dep.lagDays * scale) }, p, d));
      }
      iv.set(k, { s, f: s + d });
    }
    return iv;
  };

  const assumptions: string[] = ["Durations are calendar days; weekends and holidays are not excluded."];
  let scale = 1;
  let iv = build(1);
  const finishOf = (m: Map<string, { s: number; f: number }>) => Math.max(...[...m.values()].map((x) => x.f));
  if (submissionDate) {
    const available = toDay(submissionDate) + 1 - start;
    const nominal = finishOf(iv) - start;
    scale = available / nominal;
    iv = build(scale);
    for (let i = 0; i < 200 && finishOf(iv) - start > available && scale > 0.01; i++) {
      scale *= 0.98;
      iv = build(scale);
    }
    if (finishOf(iv) - start > available) {
      assumptions.push(`Even at one day per stage the plan cannot finish by ${submissionDate}; review the stages or the deadline.`);
    }
    assumptions.push(
      Math.abs(scale - 1) < 0.005
        ? "Typical stage durations fit the time available."
        : `Typical stage durations were scaled by ${scale.toFixed(2)}× to fit ${available} days before the submission date.`,
    );
  } else {
    assumptions.push("No submission date is set, so typical stage durations were used.");
  }
  const excluded = stagesIn.filter((s) => !s.include);
  if (excluded.length) assumptions.push(`Not scheduled: ${excluded.map((s) => s.name).join(", ")}.`);

  const tasks: ProposalTask[] = [];
  const dependencies: ProposalDependency[] = [];
  const ref = (k: string) => `stage:${byKey.get(k)!.id}`;
  for (const k of order) {
    const st = byKey.get(k)!;
    const i = iv.get(k)!;
    tasks.push({ ref: ref(k), stageId: st.id, kind: "task", title: st.name, startDate: fromDay(i.s), endDate: fromDay(i.f - 1) });
    for (const d of deps.get(k)!) dependencies.push({ predecessorRef: ref(d.key), successorRef: ref(k), type: d.type, lagDays: Math.round(d.lagDays * scale) });
    if (st.milestoneName) {
      const day = fromDay(i.f - 1);
      tasks.push({ ref: `milestone:${st.id}`, stageId: st.id, kind: "milestone", title: st.milestoneName, startDate: day, endDate: day });
      dependencies.push({ predecessorRef: ref(k), successorRef: `milestone:${st.id}`, type: "FS", lagDays: 0 });
    }
  }
  return { tasks, dependencies, assumptions, finishDate: fromDay(finishOf(iv) - 1) };
}
