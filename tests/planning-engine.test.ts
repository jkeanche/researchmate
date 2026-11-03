import { WORKFLOW_TEMPLATE_SEEDS } from "@researchmate/database";
import {
  addDays,
  criticalPath,
  findCycle,
  findViolations,
  forecast,
  isOverdue,
  type PlanDependency,
  PlanningError,
  type PlanTask,
  proposeSchedule,
  reschedule,
  rollUp,
  scheduleVariance,
  spanDays,
  TaskTree,
  todayIso,
  validateNewDependency,
  validateParent,
  weightedProgress,
} from "@researchmate/planning/engine";
import { describe, expect, it } from "vitest";

const T = (id: string, start: string, end: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  parentId: null,
  kind: "task",
  title: id.toUpperCase(),
  startDate: start,
  endDate: end,
  status: "todo",
  progressPercent: 0,
  ...extra,
});
const M = (id: string, date: string, extra: Partial<PlanTask> = {}) => T(id, date, date, { kind: "milestone", ...extra });
const D = (p: string, s: string, type: PlanDependency["type"] = "FS", lagDays = 0): PlanDependency => ({ predecessorId: p, successorId: s, type, lagDays });

describe("dates", () => {
  it("handles month/year boundaries and leap days in UTC", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(spanDays("2026-03-01", "2026-03-01")).toBe(1);
    expect(todayIso(new Date("2026-11-01T22:30:00Z"), "Africa/Nairobi")).toBe("2026-11-02");
    expect(todayIso(new Date("2026-11-01T22:30:00Z"), "Not/AZone")).toBe("2026-11-01");
  });
});

describe("dependency validation", () => {
  const tasks = [T("a", "2026-01-01", "2026-01-05"), T("b", "2026-01-06", "2026-01-10"), T("c", "2026-01-11", "2026-01-12")];

  it("rejects direct and transitive cycles", () => {
    const deps = [D("a", "b"), D("b", "c")];
    expect(() => validateNewDependency(tasks, deps, D("c", "a"))).toThrow(/loop: C → A → B → C|loop/);
    expect(() => validateNewDependency(tasks, [D("a", "b")], D("b", "a"))).toThrow(PlanningError);
    expect(() => validateNewDependency(tasks, [], D("a", "a"))).toThrow(/itself/);
    expect(() => validateNewDependency(tasks, [D("a", "b")], D("a", "b"))).toThrow(/already exists/);
    expect(() => validateNewDependency(tasks, [], D("a", "b", "FS", 400))).toThrow(/Lag/);
  });

  it("treats summaries as their subtrees when looking for cycles", () => {
    const tree = [T("p", "2026-01-01", "2026-01-10"), T("p1", "2026-01-01", "2026-01-04", { parentId: "p" }), T("x", "2026-01-11", "2026-01-12")];
    // p → x, then x → p1 is a loop because p1 is inside p.
    expect(() => validateNewDependency(tree, [D("p", "x")], D("x", "p1"))).toThrow(/loop/);
    expect(() => validateNewDependency(tree, [], D("p", "p1"))).toThrow(/parent or subtask/);
    expect(findCycle(tree, [D("p", "x")])).toBeNull();
  });

  it("validates parent changes", () => {
    const tree = [T("p", "2026-01-01", "2026-01-10"), T("c", "2026-01-01", "2026-01-04", { parentId: "p" }), M("m", "2026-01-10")];
    expect(() => validateParent(tree, "p", "c")).toThrow(/inside itself/);
    expect(() => validateParent(tree, "c", "m")).toThrow(/milestone/);
    expect(() => validateParent(tree, "m", "p", [D("m", "p")])).toThrow(/dependency/);
    expect(() => validateParent(tree, null, "p")).not.toThrow();
  });
});

describe("dependency types", () => {
  const base = (type: PlanDependency["type"], lag = 0) => {
    const tasks = [T("a", "2026-03-01", "2026-03-10"), T("b", "2026-02-01", "2026-02-04")]; // b lasts 4 days
    return reschedule(tasks, [D("a", "b", type, lag)], []).tasks.find((t) => t.id === "b")!;
  };
  it("FS: successor starts the day after the predecessor finishes (+lag)", () => {
    expect(base("FS")).toMatchObject({ startDate: "2026-03-11", endDate: "2026-03-14" });
    expect(base("FS", 2)).toMatchObject({ startDate: "2026-03-13" });
  });
  it("SS: successor starts no earlier than the predecessor starts", () => {
    expect(base("SS")).toMatchObject({ startDate: "2026-03-01", endDate: "2026-03-04" });
  });
  it("FF: successor finishes no earlier than the predecessor finishes", () => {
    expect(base("FF")).toMatchObject({ startDate: "2026-03-07", endDate: "2026-03-10" });
  });
  it("SF: successor finishes no earlier than the predecessor starts", () => {
    // Finishes at the end of the day before the predecessor starts (same instant).
    expect(base("SF")).toMatchObject({ startDate: "2026-02-25", endDate: "2026-02-28" });
  });
  it("milestones sit at the end of their day", () => {
    const tasks = [T("a", "2026-03-01", "2026-03-10"), M("m", "2026-01-01"), T("c", "2026-01-01", "2026-01-02")];
    const r = reschedule(tasks, [D("a", "m"), D("m", "c")], []);
    expect(r.tasks.find((t) => t.id === "m")).toMatchObject({ startDate: "2026-03-10", endDate: "2026-03-10" });
    expect(r.tasks.find((t) => t.id === "c")).toMatchObject({ startDate: "2026-03-11", endDate: "2026-03-12" });
  });
});

describe("reschedule (Gantt edits)", () => {
  const tasks = [
    T("a", "2026-01-01", "2026-01-05"),
    T("b", "2026-01-06", "2026-01-10"),
    T("c", "2026-01-11", "2026-01-15"),
    T("free", "2026-02-01", "2026-02-02"),
  ];
  const deps = [D("a", "b"), D("b", "c")];

  it("cascades a later move through successors, preserving durations", () => {
    const r = reschedule(tasks, deps, [{ id: "a", startDate: "2026-01-03", endDate: "2026-01-07" }]);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by.b).toMatchObject({ startDate: "2026-01-08", endDate: "2026-01-12" });
    expect(by.c).toMatchObject({ startDate: "2026-01-13", endDate: "2026-01-17" });
    expect(by.free).toMatchObject({ startDate: "2026-02-01" });
    expect(r.changes.map((c) => [c.id, c.reason])).toEqual([
      ["a", "edit"],
      ["b", "cascade"],
      ["c", "cascade"],
    ]);
  });

  it("does not pull successors earlier", () => {
    const r = reschedule(tasks, deps, [{ id: "a", startDate: "2025-12-20", endDate: "2025-12-24" }]);
    expect(r.changes).toHaveLength(1);
  });

  it("rejects moving a task before its predecessor allows", () => {
    expect(() => reschedule(tasks, deps, [{ id: "b", startDate: "2026-01-04", endDate: "2026-01-08" }])).toThrow(/can't start before 2026-01-06/);
  });

  it("refuses to move a locked deadline unless an approver allows it", () => {
    const locked = tasks.map((t) => (t.id === "c" ? { ...t, deadlineLocked: true } : t));
    expect(() => reschedule(locked, deps, [{ id: "a", startDate: "2026-01-02", endDate: "2026-01-06" }])).toThrow(/approved deadline/);
    expect(() => reschedule(locked, deps, [{ id: "c", startDate: "2026-01-12", endDate: "2026-01-16" }])).toThrow(/approved deadline/);
    const ok = reschedule(locked, deps, [{ id: "a", startDate: "2026-01-02", endDate: "2026-01-06" }], { allowLockedChanges: true });
    expect(ok.tasks.find((t) => t.id === "c")!.endDate).toBe("2026-01-16");
  });

  it("moves a summary task with its subtasks and rejects resizing it", () => {
    const tree = [
      T("p", "2026-01-01", "2026-01-10"),
      T("p1", "2026-01-01", "2026-01-04", { parentId: "p" }),
      T("p2", "2026-01-05", "2026-01-10", { parentId: "p" }),
      T("after", "2026-01-11", "2026-01-12"),
    ];
    const r = reschedule(tree, [D("p", "after")], [{ id: "p", startDate: "2026-01-03", endDate: "2026-01-12" }]);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by.p1).toMatchObject({ startDate: "2026-01-03", endDate: "2026-01-06" });
    expect(by.p2).toMatchObject({ startDate: "2026-01-07", endDate: "2026-01-12" });
    expect(by.after).toMatchObject({ startDate: "2026-01-13" });
    expect(() => reschedule(tree, [], [{ id: "p", startDate: "2026-01-01", endDate: "2026-01-20" }])).toThrow(/takes its dates from its subtasks/);
  });

  it("pushes a summary's dependants when a subtask grows", () => {
    const tree = [T("p", "2026-01-01", "2026-01-10"), T("p1", "2026-01-01", "2026-01-10", { parentId: "p" }), T("after", "2026-01-11", "2026-01-12")];
    const r = reschedule(tree, [D("p", "after")], [{ id: "p1", startDate: "2026-01-01", endDate: "2026-01-15" }]);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by.p).toMatchObject({ endDate: "2026-01-15" });
    expect(by.after).toMatchObject({ startDate: "2026-01-16" });
    expect(r.changes.find((c) => c.id === "p")!.reason).toBe("rollup");
  });

  it("reports existing violations", () => {
    const v = findViolations([T("a", "2026-01-01", "2026-01-05"), T("b", "2026-01-03", "2026-01-04")], [D("a", "b")]);
    expect(v).toEqual([expect.objectContaining({ predecessorId: "a", successorId: "b", shortfallDays: 3 })]);
  });

  it("rolls summary dates up from children", () => {
    const r = rollUp([T("p", "2020-01-01", "2020-01-01"), T("c1", "2026-01-03", "2026-01-04", { parentId: "p" }), M("c2", "2026-01-09", { parentId: "p" })]);
    expect(r.find((t) => t.id === "p")).toMatchObject({ startDate: "2026-01-03", endDate: "2026-01-09" });
  });
});

describe("critical path", () => {
  it("finds the longest chain and float on parallel work", () => {
    // a(5) → b(5) → d ; a → c(2) → d ; d(1)
    const tasks = [T("a", "2026-01-01", "2026-01-05"), T("b", "2026-01-06", "2026-01-10"), T("c", "2026-01-06", "2026-01-07"), T("d", "2026-01-11", "2026-01-11")];
    const r = criticalPath(tasks, [D("a", "b"), D("a", "c"), D("b", "d"), D("c", "d")]);
    expect([...r.critical].sort()).toEqual(["a", "b", "d"]);
    expect(r.floatDays.get("c")).toBe(3);
    expect(r.projectFinish).toBe("2026-01-11");
  });

  it("handles SS/FF links and summaries", () => {
    const tasks = [
      T("p", "2026-01-01", "2026-01-10"),
      T("p1", "2026-01-01", "2026-01-10", { parentId: "p" }),
      T("q", "2026-01-03", "2026-01-12"),
      T("r", "2026-01-01", "2026-01-02"),
    ];
    const r = criticalPath(tasks, [D("p", "q", "SS", 2)]);
    expect(r.critical.has("p1")).toBe(true);
    expect(r.critical.has("q")).toBe(true);
    expect(r.critical.has("p")).toBe(true);
    expect(r.floatDays.get("r")).toBe(10);
  });
});

describe("status, forecast, variance, progress", () => {
  const today = "2026-01-10";
  it("flags overdue work", () => {
    expect(isOverdue(T("a", "2026-01-01", "2026-01-09"), today)).toBe(true);
    expect(isOverdue(T("a", "2026-01-01", "2026-01-09", { status: "done" }), today)).toBe(false);
    expect(isOverdue(T("a", "2026-01-01", "2026-01-10"), today)).toBe(false);
  });

  it("forecasts from today and pushes successors of late work", () => {
    const tasks = [T("a", "2026-01-01", "2026-01-05"), T("b", "2026-01-06", "2026-01-08"), M("m", "2026-01-08")];
    const f = forecast(tasks, [D("a", "b"), D("b", "m")], today);
    expect(f.dates.get("a")).toEqual({ startDate: "2026-01-10", endDate: "2026-01-14" });
    expect(f.dates.get("b")).toEqual({ startDate: "2026-01-15", endDate: "2026-01-17" });
    expect(f.estimatedCompletion).toBe("2026-01-17");
  });

  it("forecasts in-progress work from its remaining share", () => {
    const f = forecast([T("a", "2026-01-01", "2026-01-10", { status: "in_progress", progressPercent: 50 })], [], today);
    expect(f.dates.get("a")!.endDate).toBe("2026-01-14");
    const done = forecast([T("a", "2026-01-01", "2026-01-10", { status: "done", actualEndDate: "2026-01-08" })], [], today);
    expect(done.estimatedCompletion).toBe("2026-01-08");
  });

  it("computes variance against an immutable baseline", () => {
    const base = [
      { taskId: "a", kind: "task", title: "A", startDate: "2026-01-01", endDate: "2026-01-05" },
      { taskId: "gone", kind: "task", title: "Gone", startDate: "2026-01-01", endDate: "2026-01-02" },
    ];
    const v = scheduleVariance([T("a", "2026-01-03", "2026-01-09"), T("new", "2026-01-01", "2026-01-02")], base);
    expect(v.rows[0]).toMatchObject({ startVarianceDays: 2, finishVarianceDays: 4, removed: false });
    expect(v.rows[1]).toMatchObject({ removed: true, finishVarianceDays: null });
    expect(v.added).toEqual(["new"]);
  });

  it("weights progress by duration and ignores cancelled and summary rows", () => {
    const tasks = [
      T("p", "2026-01-01", "2026-01-30"),
      T("long", "2026-01-01", "2026-01-30", { parentId: "p", progressPercent: 50 }),
      T("short", "2026-01-01", "2026-01-10", { status: "done" }),
      T("x", "2026-01-01", "2026-01-30", { status: "cancelled" }),
      M("m", "2026-01-30"),
    ];
    expect(weightedProgress(tasks)).toBe(Math.round((30 * 50 + 10 * 100) / 40));
    expect(weightedProgress([M("m", "2026-01-30", { status: "done" }), M("n", "2026-01-30")])).toBe(50);
    expect(weightedProgress([])).toBe(0);
  });

  it("numbers the work breakdown structure", () => {
    const tree = new TaskTree([
      T("a", "2026-01-01", "2026-01-02", { sortOrder: 1 }),
      T("b", "2026-01-01", "2026-01-02", { sortOrder: 2 }),
      T("b1", "2026-01-01", "2026-01-02", { parentId: "b", sortOrder: 1 }),
      T("b2", "2026-01-01", "2026-01-02", { parentId: "b", sortOrder: 2 }),
    ]);
    expect(tree.outline().map((o) => `${o.wbs}:${o.id}`)).toEqual(["1:a", "2:b", "2.1:b1", "2.2:b2"]);
  });
});

describe("schedule proposals", () => {
  const stages = (key: string) =>
    WORKFLOW_TEMPLATE_SEEDS.find((w) => w.key === key)!.stages.map((s, i) => ({
      id: `s${i}`,
      key: s.key,
      name: s.name,
      nominalDurationDays: s.durationDays,
      dependsOn: (s.dependsOn ?? []).map((d) => (typeof d === "string" ? { key: d, type: "FS" as const, lagDays: 0 } : { key: d.key, type: d.type, lagDays: d.lagDays ?? 0 })),
      milestoneName: s.milestone ?? null,
      include: true,
    }));

  it("every seeded template is acyclic and references only its own stages", () => {
    for (const w of WORKFLOW_TEMPLATE_SEEDS) {
      const keys = new Set(w.stages.map((s) => s.key));
      for (const s of w.stages) for (const d of s.dependsOn ?? []) expect(keys.has(typeof d === "string" ? d : d.key), `${w.key}.${s.key}`).toBe(true);
      expect(() => proposeSchedule(stages(w.key), "2026-01-01", null)).not.toThrow();
    }
  });

  it("fits the plan inside the submission window and keeps dependencies valid", () => {
    const p = proposeSchedule(stages("thesis_full"), "2026-01-05", "2026-12-18");
    expect(p.finishDate <= "2026-12-18").toBe(true);
    expect(p.finishDate >= "2026-11-15").toBe(true); // uses most of the window
    expect(p.tasks[0]!.startDate).toBe("2026-01-05");
    expect(p.tasks.filter((t) => t.kind === "milestone").map((t) => t.title)).toEqual(["Proposal approved", "Thesis submitted"]);
    const asTasks: PlanTask[] = p.tasks.map((t) => T(t.ref, t.startDate, t.endDate, { kind: t.kind, title: t.title }));
    const asDeps = p.dependencies.map((d) => D(d.predecessorRef, d.successorRef, d.type, d.lagDays));
    expect(findViolations(asTasks, asDeps)).toEqual([]);
    expect(findCycle(asTasks, asDeps)).toBeNull();
    expect(p.assumptions.join(" ")).toMatch(/scaled by/);
  });

  it("bridges excluded stages and is deterministic", () => {
    const s = stages("report").map((x) => (x.key === "data_collection" ? { ...x, include: false } : x));
    const a = proposeSchedule(s, "2026-03-02", null);
    const b = proposeSchedule(s, "2026-03-02", null);
    expect(a).toEqual(b);
    const analysis = a.tasks.find((t) => t.title === "Analysis")!;
    const desk = a.tasks.find((t) => t.title === "Desk research")!;
    expect(a.dependencies).toContainEqual(expect.objectContaining({ predecessorRef: desk.ref, successorRef: analysis.ref }));
    expect(a.assumptions.join(" ")).toMatch(/Not scheduled: Primary research/);
  });

  it("rejects impossible input", () => {
    expect(() => proposeSchedule(stages("article"), "2026-03-02", "2026-03-01")).toThrow(/before the start/);
    expect(() => proposeSchedule(stages("article").map((s) => ({ ...s, include: false })), "2026-03-02", null)).toThrow(/no enabled/);
  });
});
