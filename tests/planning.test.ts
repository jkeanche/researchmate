import { projectScheduleBaselineItems, projectScheduleBaselines, projectScheduleRevisions, projectStages, researchProjects, researchTasks } from "@researchmate/database";
import { PlanningService, workload } from "@researchmate/planning";
import { ProjectMemberService, ProjectService, ResearchContentService, WorkflowService } from "@researchmate/research";
import { addMemberByEmail } from "@researchmate/tenancy";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";

afterAll(closeTestDb);

const db = () => testDb();
const planning = () => new PlanningService(db());
const projects = () => new ProjectService(db());

async function proProject(opts: { template?: string } = {}) {
  const owner = await createUser("Owner");
  await setPlan(owner.orgId, "research_pro");
  const p = await projects().create(owner.userId, owner.orgId, {
    title: "Soil moisture and maize yields",
    researchType: "masters_thesis",
    startDate: "2026-01-05",
    expectedCompletionDate: "2026-12-18",
    ...(opts.template !== undefined ? { workflowTemplateKey: opts.template } : {}),
  });
  return { owner, project: p };
}

/** Adds a new user to the owner's organization and project with the given project role. */
async function teammate(owner: { userId: string; orgId: string }, projectId: string, roleKey: string, name = roleKey) {
  const u = await createUser(name);
  await addMemberByEmail(db(), owner.userId, owner.orgId, u.email, "org_member");
  await new ProjectMemberService(db()).add(owner.userId, projectId, u.userId, roleKey);
  return u;
}

const task = (projectId: string, userId: string, title: string, startDate: string, endDate: string, extra: Record<string, unknown> = {}) =>
  planning().createTask(userId, projectId, { title, startDate, endDate, ...extra }).then((r) => r.task);

describe("workflow templates", () => {
  it("new projects copy the default template for their research type", async () => {
    const { owner, project } = await proProject();
    const wf = await new WorkflowService(db()).list(owner.userId, project.id);
    expect(wf.stages.length).toBe(20);
    expect(wf.stages[0]!.name).toBe("Project setup");
    const [p] = await db().select().from(researchProjects).where(eq(researchProjects.id, project.id));
    expect(p!.workflowTemplateKey).toBe("thesis_full");
    expect(p!.progressSource).toBe("tasks");
  });

  it("stages can be reordered, repeated, disabled, and approval gates track waiting time", async () => {
    const { owner, project } = await proProject();
    const wf = new WorkflowService(db());
    let { stages } = await wf.list(owner.userId, project.id);
    const refine = stages.find((s) => s.key === "topic_refinement")!;
    await wf.transition(owner.userId, refine.id, "start");
    expect(await wf.transition(owner.userId, refine.id, "complete")).toBe("awaiting_approval");
    await db().update(projectStages).set({ awaitingApprovalSince: sql`now() - interval '2 hours'` }).where(eq(projectStages.id, refine.id));
    expect(await wf.transition(owner.userId, refine.id, "approve", "Scope agreed")).toBe("completed");
    const [after] = await db().select().from(projectStages).where(eq(projectStages.id, refine.id));
    expect(after!.approvalWaitSeconds).toBeGreaterThanOrEqual(7190);
    expect(after!.approvedByUserId).toBe(owner.userId);

    const setup = stages.find((s) => s.key === "setup")!;
    await expect(wf.transition(owner.userId, setup.id, "skip")).rejects.toThrow(/Only optional stages/);
    await expect(wf.transition(owner.userId, setup.id, "complete")).rejects.toThrow(/Start the stage/);

    const dc = stages.find((s) => s.key === "data_collection")!;
    const copy = await wf.repeatStage(owner.userId, dc.id);
    expect(copy.iteration).toBe(2);
    ({ stages } = await wf.list(owner.userId, project.id));
    const idx = stages.findIndex((s) => s.id === dc.id);
    expect(stages[idx + 1]!.id).toBe(copy.id);
    expect(stages.find((s) => s.key === "analysis")!.dependsOn[0]!.key).toBe(copy.key);

    await wf.moveStage(owner.userId, setup.id, "down");
    ({ stages } = await wf.list(owner.userId, project.id));
    expect(stages[1]!.id).toBe(setup.id);
    await wf.updateStage(owner.userId, setup.id, { enabled: false });
    ({ stages } = await wf.list(owner.userId, project.id));
    expect(stages.find((s) => s.id === setup.id)!.enabled).toBe(false);
  });
});

describe("research questions and objectives", () => {
  it("records questions, objectives and hypotheses with alignment gaps", async () => {
    const { owner, project } = await proProject();
    const rc = new ResearchContentService(db());
    const q1 = await rc.addQuestion(owner.userId, project.id, { kind: "main", text: "How does soil moisture affect yield?" });
    const q2 = await rc.addQuestion(owner.userId, project.id, { text: "Which irrigation schedules are used?" });
    await rc.addObjective(owner.userId, project.id, { text: "Measure moisture across plots", questionId: q1.id });
    await rc.addObjective(owner.userId, project.id, { text: "Unlinked objective" });
    await rc.addHypothesis(owner.userId, project.id, { nullHypothesis: "No effect", alternativeHypothesis: "Positive effect", questionId: q1.id });
    const list = await rc.list(owner.userId, project.id);
    expect(list.alignment.rows.map((r) => r.label)).toEqual(["MQ1", "RQ1"]);
    expect(list.alignment.unansweredQuestionIds).toEqual([q2.id]);
    expect(list.alignment.unlinkedObjectiveIds).toHaveLength(1);
    await rc.move(owner.userId, "question", q2.id, "up");
    expect((await rc.list(owner.userId, project.id)).questions[0]!.id).toBe(q2.id);

    const other = await proProject();
    await expect(rc.addObjective(owner.userId, project.id, { text: "x", questionId: (await rc.addQuestion(other.owner.userId, other.project.id, { text: "foreign" })).id })).rejects.toThrow(/does not belong/);
    await expect(rc.addQuestion(other.owner.userId, project.id, { text: "intrusion" })).rejects.toThrow(/not found/i);
  });
});

describe("planning entitlements", () => {
  it("Free plan: overview only — limited tasks, no dependencies, drag, baselines or risks", async () => {
    const u = await createUser();
    const p = await projects().create(u.userId, u.orgId, { title: "Free project", researchType: "independent_research" });
    const a = await task(p.id, u.userId, "A", "2026-02-01", "2026-02-05");
    const b = await task(p.id, u.userId, "B", "2026-02-06", "2026-02-07");
    await expect(planning().addDependency(u.userId, p.id, { predecessorId: a.id, successorId: b.id })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(planning().updateTask(u.userId, a.id, { startDate: "2026-02-02", endDate: "2026-02-06" }, { source: "gantt" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(planning().createBaseline(u.userId, p.id, {})).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(planning().createRisk(u.userId, p.id, { title: "R", likelihood: 2, impact: 2 })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    await expect(planning().proposeFromWorkflow(u.userId, p.id, {})).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    // Editing dates through the task form is allowed on overview.
    await planning().updateTask(u.userId, a.id, { startDate: "2026-02-02", endDate: "2026-02-06" });

    for (let i = 2; i < 20; i++) await task(p.id, u.userId, `T${i}`, "2026-03-01", "2026-03-02");
    await expect(task(p.id, u.userId, "one too many", "2026-03-01", "2026-03-02")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("concurrent task creation cannot exceed the per-project limit", async () => {
    const u = await createUser();
    const p = await projects().create(u.userId, u.orgId, { title: "Race", researchType: "custom", workflowTemplateKey: "" });
    for (let i = 0; i < 18; i++) await task(p.id, u.userId, `T${i}`, "2026-03-01", "2026-03-02");
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => task(p.id, u.userId, `R${i}`, "2026-03-01", "2026-03-02")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const [n] = await db().select({ n: sql<number>`count(*)`.mapWith(Number) }).from(researchTasks).where(eq(researchTasks.projectId, p.id));
    expect(n!.n).toBe(20);
  });
});

describe("tasks, dependencies and cascading", () => {
  it("validates dependencies, rejects cycles and cascades Gantt moves with revisions", async () => {
    const { owner, project } = await proProject({ template: "" });
    const a = await task(project.id, owner.userId, "Literature search", "2026-02-02", "2026-02-13");
    const b = await task(project.id, owner.userId, "Write review", "2026-02-16", "2026-03-06");
    const m = await planning().createTask(owner.userId, project.id, { title: "Review submitted", kind: "milestone", startDate: "2026-03-06" }).then((r) => r.task);
    await planning().addDependency(owner.userId, project.id, { predecessorId: a.id, successorId: b.id, type: "FS" });
    await planning().addDependency(owner.userId, project.id, { predecessorId: b.id, successorId: m.id, type: "FS" });
    await expect(planning().addDependency(owner.userId, project.id, { predecessorId: m.id, successorId: a.id })).rejects.toThrow(/loop/);
    await expect(planning().addDependency(owner.userId, project.id, { predecessorId: a.id, successorId: b.id })).rejects.toThrow(/already exists/);

    // Drag A one week later: B and the milestone follow.
    const r = await planning().updateTask(owner.userId, a.id, { startDate: "2026-02-09", endDate: "2026-02-20" }, { source: "gantt", expectedVersion: a.version });
    expect(r.changes.map((c) => c.id).sort()).toEqual([a.id, b.id, m.id].sort());
    const rows = await db().select().from(researchTasks).where(eq(researchTasks.projectId, project.id));
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(by[b.id]).toMatchObject({ startDate: "2026-02-21", endDate: "2026-03-11" }); // 19 days, pushed 5
    expect(by[m.id]).toMatchObject({ startDate: "2026-03-11" });
    const revs = await db().select().from(projectScheduleRevisions).where(eq(projectScheduleRevisions.projectId, project.id));
    expect(revs.map((x) => x.source).sort()).toEqual(["cascade", "cascade", "gantt"]);

    // Stale version → conflict; moving B before A finishes → rejected.
    await expect(planning().updateTask(owner.userId, a.id, { startDate: "2026-02-10", endDate: "2026-02-21" }, { expectedVersion: a.version })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(planning().updateTask(owner.userId, b.id, { startDate: "2026-02-18", endDate: "2026-03-10" })).rejects.toThrow(/can't start before 2026-02-21/);
  });

  it("subtasks roll up into their parent and extend the parent's successors", async () => {
    const { owner, project } = await proProject({ template: "" });
    const parent = await task(project.id, owner.userId, "Fieldwork", "2026-04-01", "2026-04-01");
    const next = await task(project.id, owner.userId, "Analysis", "2026-04-02", "2026-04-10");
    await planning().addDependency(owner.userId, project.id, { predecessorId: parent.id, successorId: next.id });
    await task(project.id, owner.userId, "Site A", "2026-04-01", "2026-04-07", { parentTaskId: parent.id });
    const rows = await db().select().from(researchTasks).where(eq(researchTasks.projectId, project.id));
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(by[parent.id]).toMatchObject({ startDate: "2026-04-01", endDate: "2026-04-07" });
    expect(by[next.id]).toMatchObject({ startDate: "2026-04-08", endDate: "2026-04-16" });
    await expect(planning().createTask(owner.userId, project.id, { title: "bad", startDate: "2026-04-01", parentTaskId: (await planning().createTask(owner.userId, project.id, { title: "M", kind: "milestone", startDate: "2026-05-01" })).task.id })).rejects.toThrow(/milestone cannot contain/);
  });

  it("locked deadlines move only with an approver's explicit confirmation", async () => {
    const { owner, project } = await proProject({ template: "" });
    const researcher = await teammate(owner, project.id, "project_researcher", "Researcher");
    const a = await task(project.id, owner.userId, "Data collection", "2026-05-04", "2026-05-29");
    const sub = await planning().createTask(owner.userId, project.id, { title: "Proposal deadline", kind: "milestone", startDate: "2026-05-29" }).then((r) => r.task);
    await planning().addDependency(owner.userId, project.id, { predecessorId: a.id, successorId: sub.id });
    await expect(planning().updateTask(researcher.userId, sub.id, { deadlineLocked: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await planning().updateTask(owner.userId, sub.id, { deadlineLocked: true });

    await expect(planning().updateTask(researcher.userId, a.id, { endDate: "2026-06-05" })).rejects.toThrow(/approved deadline/);
    await expect(planning().updateTask(researcher.userId, a.id, { endDate: "2026-06-05" }, { confirmLockedChange: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await planning().updateTask(owner.userId, a.id, { endDate: "2026-06-05" }, { confirmLockedChange: true, reason: "Ethics approval delayed" });
    expect(r.changes.find((c) => c.id === sub.id)!.endDate).toBe("2026-06-05");
    const [rev] = await db().select().from(projectScheduleRevisions).where(and(eq(projectScheduleRevisions.taskId, sub.id)));
    expect(rev).toMatchObject({ source: "locked_override", reason: "Ethics approval delayed", changedByUserId: owner.userId });
    await expect(planning().deleteTask(researcher.userId, sub.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("derives project progress from tasks and supports completion approval", async () => {
    const { owner, project } = await proProject({ template: "" });
    const assistant = await teammate(owner, project.id, "project_assistant", "Assistant");
    const t1 = await task(project.id, owner.userId, "Transcribe", "2026-02-01", "2026-02-10", { assigneeUserId: assistant.userId, requiresCompletionApproval: true });
    const t2 = await task(project.id, owner.userId, "Code interviews", "2026-02-11", "2026-02-20");

    await planning().updateTask(assistant.userId, t1.id, { progressPercent: 50 });
    let [p] = await db().select().from(researchProjects).where(eq(researchProjects.id, project.id));
    expect(p!.progressPercent).toBe(25);
    const [row] = await db().select().from(researchTasks).where(eq(researchTasks.id, t1.id));
    expect(row!.status).toBe("in_progress");
    expect(row!.actualStartDate).not.toBeNull();

    // Assistant: may update own task's progress, not dates, not other people's tasks.
    await expect(planning().updateTask(assistant.userId, t1.id, { endDate: "2026-02-12" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(planning().updateTask(assistant.userId, t2.id, { progressPercent: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const done = await planning().updateTask(assistant.userId, t1.id, { status: "done" });
    expect(done.task.status).toBe("in_review");
    expect(done.message).toMatch(/approval/);
    await expect(planning().approveCompletion(assistant.userId, t1.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await planning().approveCompletion(owner.userId, t1.id);
    [p] = await db().select().from(researchProjects).where(eq(researchProjects.id, project.id));
    expect(p!.progressPercent).toBe(50);

    // Checklists and comments.
    const item = await planning().addChecklistItem(assistant.userId, t1.id, "Check audio quality");
    await planning().setChecklistItem(assistant.userId, item.id, true);
    await planning().addComment(assistant.userId, t1.id, "All 12 interviews transcribed.");
    const detail = await planning().getTask(owner.userId, t1.id);
    expect(detail.checklist[0]!.done).toBe(true);
    expect(detail.comments[0]!.authorName).toBe("Assistant");
  });

  it("supervisors can read, comment and approve stages but cannot edit the plan", async () => {
    const { owner, project } = await proProject();
    const sup = await teammate(owner, project.id, "project_supervisor", "Supervisor");
    const t = await task(project.id, owner.userId, "Draft chapter 1", "2026-02-01", "2026-02-28");
    await expect(task(project.id, sup.userId, "x", "2026-02-01", "2026-02-02")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(planning().updateTask(sup.userId, t.id, { title: "renamed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await planning().addComment(sup.userId, t.id, "Please tighten the problem statement.");
    const plan = await planning().getPlan(sup.userId, project.id);
    expect(plan.tasks).toHaveLength(1);

    const wf = new WorkflowService(db());
    const stage = (await wf.list(owner.userId, project.id)).stages.find((s) => s.key === "topic_refinement")!;
    await wf.transition(owner.userId, stage.id, "start");
    await wf.transition(owner.userId, stage.id, "complete");
    await expect(wf.transition(sup.userId, stage.id, "start")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await wf.transition(sup.userId, stage.id, "request_changes", "Narrow the population")).toBe("in_progress");
  });

  it("other tenants cannot see or change the plan", async () => {
    const { owner, project } = await proProject({ template: "" });
    const t = await task(project.id, owner.userId, "Secret task", "2026-02-01", "2026-02-02");
    const outsider = await createUser("Outsider");
    await setPlan(outsider.orgId, "research_pro");
    await expect(planning().getPlan(outsider.userId, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(planning().getTask(outsider.userId, t.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(planning().updateTask(outsider.userId, t.id, { title: "pwned" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(planning().deleteTask(outsider.userId, t.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Cross-project dependency is rejected even for the same owner.
    const other = await projects().create(owner.userId, owner.orgId, { title: "Other", researchType: "custom", workflowTemplateKey: "" });
    const o = await task(other.id, owner.userId, "Other task", "2026-02-01", "2026-02-02");
    await expect(planning().addDependency(owner.userId, project.id, { predecessorId: t.id, successorId: o.id })).rejects.toThrow(/belong to this project/);
    // Assigning someone outside the project is rejected.
    await expect(planning().updateTask(owner.userId, t.id, { assigneeUserId: outsider.userId })).rejects.toThrow(/member of this project/);
  });

  it("archived projects are read-only", async () => {
    const { owner, project } = await proProject({ template: "" });
    const t = await task(project.id, owner.userId, "T", "2026-02-01", "2026-02-02");
    await projects().archive(owner.userId, project.id);
    await expect(planning().updateTask(owner.userId, t.id, { title: "x" })).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(task(project.id, owner.userId, "new", "2026-02-01", "2026-02-02")).rejects.toMatchObject({ code: "READ_ONLY" });
    expect((await planning().getPlan(owner.userId, project.id)).tasks).toHaveLength(1);
  });
});

describe("baselines", () => {
  it("saves numbered, immutable baselines that survive later schedule changes", async () => {
    const { owner, project } = await proProject({ template: "" });
    const a = await task(project.id, owner.userId, "A", "2026-02-02", "2026-02-06");
    const b1 = await planning().createBaseline(owner.userId, project.id, { name: "Approved proposal plan" });
    expect(b1.number).toBe(1);
    await planning().updateTask(owner.userId, a.id, { startDate: "2026-02-09", endDate: "2026-02-13" });
    const b2 = await planning().createBaseline(owner.userId, project.id, {});
    expect(b2).toMatchObject({ number: 2, name: "Baseline 2" });

    const first = await planning().baselineItems(owner.userId, b1.id);
    expect(first.items[0]).toMatchObject({ startDate: "2026-02-02", endDate: "2026-02-06" });

    // The database itself refuses to modify or delete a baseline.
    await expect(db().update(projectScheduleBaselineItems).set({ startDate: "2026-03-01" }).where(eq(projectScheduleBaselineItems.baselineId, b1.id))).rejects.toThrow();
    await expect(db().update(projectScheduleBaselines).set({ name: "edited" }).where(eq(projectScheduleBaselines.id, b1.id))).rejects.toThrow();
    await expect(db().delete(projectScheduleBaselines).where(eq(projectScheduleBaselines.id, b1.id))).rejects.toThrow();
    await expect(db().delete(projectScheduleBaselineItems).where(eq(projectScheduleBaselineItems.baselineId, b1.id))).rejects.toThrow();
    // Deleting the task keeps its baseline record.
    await planning().deleteTask(owner.userId, a.id);
    expect((await planning().baselineItems(owner.userId, b1.id)).items).toHaveLength(1);

    const researcher = await teammate(owner, project.id, "project_researcher");
    await expect(planning().createBaseline(researcher.userId, project.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deleting a whole project still cascades through its baselines", async () => {
    const { owner, project } = await proProject({ template: "" });
    await task(project.id, owner.userId, "A", "2026-02-02", "2026-02-06");
    const b = await planning().createBaseline(owner.userId, project.id, {});
    await db().delete(researchProjects).where(eq(researchProjects.id, project.id));
    expect(await db().select().from(projectScheduleBaselines).where(eq(projectScheduleBaselines.id, b.id))).toHaveLength(0);
  });
});

describe("schedule proposals", () => {
  it("proposes from the workflow, changes nothing until an approver accepts", async () => {
    const { owner, project } = await proProject();
    const researcher = await teammate(owner, project.id, "project_researcher");
    const { proposal, finishDate } = await planning().proposeFromWorkflow(researcher.userId, project.id, {});
    expect(finishDate <= "2026-12-18").toBe(true);
    expect((await planning().getPlan(owner.userId, project.id)).tasks).toHaveLength(0);
    await expect(planning().approveProposal(researcher.userId, proposal.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A newer proposal supersedes the pending one.
    const second = await planning().proposeFromWorkflow(owner.userId, project.id, { startDate: "2026-02-02" });
    await expect(planning().approveProposal(owner.userId, proposal.id)).rejects.toThrow(/already been decided/);
    const r = await planning().approveProposal(owner.userId, second.proposal.id);
    expect(r.created).toBe(22); // 20 stages + 2 milestones
    const plan = await planning().getPlan(owner.userId, project.id);
    expect(plan.tasks).toHaveLength(22);
    expect(plan.planDeps.length).toBeGreaterThan(20);
    const stages = await db().select().from(projectStages).where(eq(projectStages.projectId, project.id)).orderBy(asc(projectStages.sortOrder));
    expect(stages.every((s) => s.dueDate)).toBe(true);
    await expect(planning().approveProposal(owner.userId, second.proposal.id)).rejects.toThrow(/already been decided/);
  });
});

describe("risks, events, time and workload", () => {
  it("manages the risk register, calendar events and time entries", async () => {
    const { owner, project } = await proProject({ template: "" });
    const assistant = await teammate(owner, project.id, "project_assistant");
    const t = await task(project.id, owner.userId, "Survey", "2026-03-02", "2026-03-27", { assigneeUserId: assistant.userId });
    const risk = await planning().createRisk(owner.userId, project.id, { title: "Low response rate", category: "data_collection", likelihood: 4, impact: 3, mitigation: "Reminders", taskId: t.id });
    await planning().createRisk(owner.userId, project.id, { title: "Laptop failure", likelihood: 1, impact: 2 });
    expect((await planning().listRisks(owner.userId, project.id))[0]!.risk.id).toBe(risk.id);
    await expect(planning().createRisk(owner.userId, project.id, { title: "bad", likelihood: 6, impact: 1 })).rejects.toThrow();
    await planning().updateRisk(owner.userId, risk.id, { ...risk, status: "mitigating" });
    await expect(planning().createRisk(assistant.userId, project.id, { title: "x", likelihood: 1, impact: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ev = await planning().createEvent(owner.userId, project.id, { title: "Supervisor meeting", kind: "supervisor_meeting", startDate: "2026-03-10", startTime: "14:30" });
    expect(ev.endDate).toBe("2026-03-10");
    await expect(planning().createEvent(owner.userId, project.id, { title: "x", startDate: "2026-03-10", startTime: "25:00" })).rejects.toThrow(/HH:MM/);
    expect(await planning().listEvents(owner.userId, project.id, "2026-03-01", "2026-03-31")).toHaveLength(1);

    await planning().logTime(assistant.userId, project.id, { taskId: t.id, entryDate: "2026-03-03", minutes: 90, category: "data_collection" });
    await planning().logTime(owner.userId, project.id, { entryDate: "2026-03-04", minutes: 30, category: "revision" });
    await expect(planning().logTime(assistant.userId, project.id, { entryDate: "2099-01-01", minutes: 30 })).rejects.toThrow(/future/);
    const other = await task(project.id, owner.userId, "Not yours", "2026-03-02", "2026-03-03");
    await expect(planning().logTime(assistant.userId, project.id, { taskId: other.id, entryDate: "2026-03-03", minutes: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const time = await planning().listTime(owner.userId, project.id);
    expect(time.totalMinutes).toBe(120);
    expect(time.byCategory).toEqual({ data_collection: 90, revision: 30 });
  });

  it("computes weekly workload from assignees and allocations", () => {
    const base = { parentId: null, kind: "task" as const, status: "todo", progressPercent: 0 };
    const w = workload(
      [
        { ...base, id: "a", title: "A", startDate: "2026-03-02", endDate: "2026-03-08", assigneeUserId: "u1" }, // Mon–Sun full week
        { ...base, id: "b", title: "B", startDate: "2026-03-02", endDate: "2026-03-15", assigneeUserId: "u1" },
      ],
      [{ taskId: "b", userId: "u2", allocationPercent: 50 }],
      "2026-03-04",
      2,
    );
    expect(w.weekStarts).toEqual(["2026-03-02", "2026-03-09"]);
    expect(w.rows.find((r) => r.userId === "u1")!.load).toEqual([100, 0]);
    expect(w.rows.find((r) => r.userId === "u2")!.load).toEqual([50, 50]);
  });
});
