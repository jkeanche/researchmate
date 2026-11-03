/**
 * Development only: creates a demo researcher with a planned thesis project so
 * the planning views have realistic content. Refuses to run in production.
 *
 *   pnpm --filter @researchmate/worker demo:seed
 *
 * Prints the demo login. Running it again creates another demo account.
 */
import { randomUUID } from "node:crypto";
import { AuthService, CapturingMailer, MemoryRateLimiter } from "@researchmate/auth";
import { closeDb, getDb, organizations, plans, researchTasks, subscriptions } from "@researchmate/database";
import { FinanceService } from "@researchmate/finance";
import { addDays, PlanningService, todayIso } from "@researchmate/planning";
import { ProjectMemberService, ProjectService, ResearchContentService, WorkflowService } from "@researchmate/research";
import { addMemberByEmail } from "@researchmate/tenancy";
import { asc, eq } from "drizzle-orm";

if (process.env.NODE_ENV === "production") {
  console.error("seed-demo refuses to run with NODE_ENV=production.");
  process.exit(1);
}

const db = getDb();
const auth = new AuthService({ db, mailer: new CapturingMailer(), limiter: new MemoryRateLimiter(), config: { appUrl: process.env.APP_URL ?? "http://localhost:3000", requireEmailVerification: false, sessionTtlDays: 30 } });
const password = "demo password for planning";
const tag = randomUUID().slice(0, 6);

async function user(name: string, email: string) {
  const r = await auth.register({ email, password, displayName: name });
  if (r.status !== "signed_in") throw new Error("registration failed");
  const [org] = await db.select().from(organizations).where(eq(organizations.ownerUserId, r.userId));
  return { userId: r.userId, orgId: org!.id, email };
}

async function main() {
  const today = todayIso();
  const lead = await user("Amina Wanjiru", `demo-${tag}@example.test`);
  const [pro] = await db.select().from(plans).where(eq(plans.key, "research_pro"));
  await db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.organizationId, lead.orgId));
  await db.insert(subscriptions).values({ organizationId: lead.orgId, planId: pro!.id, status: "active" });
  const assistant = await user("Brian Otieno", `demo-${tag}-ra@example.test`);
  const supervisor = await user("Dr. Grace Mutua", `demo-${tag}-sup@example.test`);
  for (const u of [assistant, supervisor]) await addMemberByEmail(db, lead.userId, lead.orgId, u.email, "org_member");

  const start = addDays(today, -75);
  const project = await new ProjectService(db).create(lead.userId, lead.orgId, {
    title: "Soil moisture monitoring and smallholder maize yields in Machakos County",
    researchType: "masters_thesis",
    academicLevel: "Master's",
    discipline: "Agricultural engineering",
    institution: "University of Nairobi",
    startDate: start,
    expectedCompletionDate: addDays(start, 330),
    description: "A mixed-methods study of low-cost soil moisture sensing and its effect on irrigation decisions and yields.",
  });
  const members = new ProjectMemberService(db);
  await members.add(lead.userId, project.id, assistant.userId, "project_assistant");
  await members.add(lead.userId, project.id, supervisor.userId, "project_supervisor");

  const rc = new ResearchContentService(db);
  const mq = await rc.addQuestion(lead.userId, project.id, { kind: "main", text: "How does access to soil moisture data affect irrigation decisions and maize yields among smallholder farmers?" });
  const q2 = await rc.addQuestion(lead.userId, project.id, { text: "What irrigation scheduling practices do farmers currently use?" });
  await rc.addQuestion(lead.userId, project.id, { text: "What barriers limit adoption of low-cost moisture sensors?" });
  await rc.addObjective(lead.userId, project.id, { kind: "general", text: "Assess the effect of soil moisture information on irrigation and yields.", questionId: mq.id });
  await rc.addObjective(lead.userId, project.id, { text: "Document current irrigation scheduling practices.", questionId: q2.id });
  await rc.addHypothesis(lead.userId, project.id, { nullHypothesis: "Sensor access has no effect on yield.", alternativeHypothesis: "Farmers with sensor access achieve higher yields.", questionId: mq.id });

  const planning = new PlanningService(db);
  const wf = new WorkflowService(db);
  const { proposal } = await planning.proposeFromWorkflow(lead.userId, project.id, {});
  await planning.approveProposal(lead.userId, proposal.id);
  await planning.createBaseline(lead.userId, project.id, { name: "Approved proposal plan", note: "Agreed with supervisor" });

  // Progress through the first stages; the literature review runs late.
  const tasks = await db.select().from(researchTasks).where(eq(researchTasks.projectId, project.id)).orderBy(asc(researchTasks.sortOrder));
  const { stages } = await wf.list(lead.userId, project.id);
  for (const t of tasks) {
    if (t.endDate < addDays(today, -12) && t.kind === "task") await planning.updateTask(lead.userId, t.id, { status: "done" });
    else if (t.startDate <= today && t.kind === "task") await planning.updateTask(lead.userId, t.id, { progressPercent: 40, assigneeUserId: t.title.includes("Literature") ? assistant.userId : lead.userId });
  }
  for (const s of stages) {
    const st = tasks.find((t) => t.stageId === s.id && t.kind === "task");
    if (!st || st.endDate >= addDays(today, -12)) break;
    await wf.transition(lead.userId, s.id, "start");
    const to = await wf.transition(lead.userId, s.id, "complete");
    if (to === "awaiting_approval") await wf.transition(supervisor.userId, s.id, "approve", "Agreed");
  }
  const lit = tasks.find((t) => t.title === "Literature review");
  if (lit) await planning.updateTask(lead.userId, lit.id, { endDate: addDays(lit.endDate, 9) }, { reason: "More sources than expected" });
  const proposalMs = tasks.find((t) => t.title === "Proposal approved");
  if (proposalMs) await planning.updateTask(lead.userId, proposalMs.id, { deadlineLocked: true });
  const fieldwork = tasks.find((t) => t.title === "Data collection");
  if (fieldwork) {
    for (const [title, offset, len] of [["Recruit 40 farmers", 0, 14], ["Install sensors", 10, 10], ["Weekly farm visits", 18, 27]] as const) {
      await planning.createTask(lead.userId, project.id, { title, parentTaskId: fieldwork.id, startDate: addDays(fieldwork.startDate, offset), endDate: addDays(fieldwork.startDate, offset + len - 1), assigneeUserId: assistant.userId });
    }
  }
  await planning.createRisk(lead.userId, project.id, { title: "Delayed ethics approval", category: "ethics", likelihood: 3, impact: 5, mitigation: "Submit the ethics application early; weekly follow-up.", ownerUserId: lead.userId });
  await planning.createRisk(lead.userId, project.id, { title: "Sensor failures in the field", category: "technical", likelihood: 3, impact: 3, mitigation: "Order 20% spare sensors." });
  await planning.createRisk(lead.userId, project.id, { title: "Farmer drop-out", category: "data_collection", likelihood: 2, impact: 4, contingency: "Recruit a reserve list of 10 farmers." });
  await planning.createEvent(lead.userId, project.id, { title: "Supervisor meeting", kind: "supervisor_meeting", startDate: addDays(today, 3), startTime: "10:00", location: "Department office" });
  await planning.logTime(lead.userId, project.id, { entryDate: addDays(today, -1), minutes: 150, category: "writing", note: "Literature review: theme 2" });
  await planning.logTime(assistant.userId, project.id, { entryDate: today, minutes: 90, category: "research", taskId: lit?.id ?? null });
  await planning.logTime(lead.userId, project.id, { entryDate: addDays(today, -3), minutes: 60, category: "revision" });

  // Optional finances: a USD grant reported in KES.
  const fin = new FinanceService(db);
  await fin.configure(lead.userId, project.id, { enabled: true, baseCurrency: "KES" });
  await fin.addRate(lead.userId, project.id, { fromCurrency: "USD", toCurrency: "KES", rate: "129.40", rateDate: addDays(today, -90) });
  const grant = await fin.createFundingSource(lead.userId, project.id, { name: "NRF postgraduate grant", kind: "grant", funderName: "National Research Fund", reference: "NRF/PG/2026/114", currency: "USD", awarded: "2000" });
  await fin.recordReceipt(lead.userId, grant.id, { receivedDate: addDays(today, -60), amount: "1200" });
  const draft = await fin.draft(lead.userId, project.id);
  for (const [k, a] of [["fieldwork", "90000"], ["travel", "45000"], ["equipment", "60000"], ["research_assistants", "40000"], ["transcription", "15000"]] as const) await fin.setAllocation(lead.userId, draft.id, { categoryKey: k, amount: a });
  await fin.approveBudget(lead.userId, draft.id);
  const exp = async (description: string, categoryKey: string, amount: string, days: number, to: string[], extra: Record<string, unknown> = {}) => {
    const e = await fin.createExpense(lead.userId, project.id, { description, categoryKey, amount, expenseDate: addDays(today, days), fundingSourceId: grant.id, ...extra });
    for (const t of to) await fin.transitionExpense(lead.userId, e.id, t as never, { note: "ok" });
  };
  await exp("20 soil moisture sensors", "equipment", "310", -40, ["submit", "approve", "pay"], { currency: "USD", vendor: "AgriSense Ltd" });
  await exp("Field transport, week 1", "travel", "6800", -20, ["submit", "approve", "pay"], { paymentMethod: "mobile_money" });
  await exp("Enumerator stipends", "research_assistants", "18000", -5, ["submit", "approve"]);
  await exp("Printing questionnaires", "printing", "2400", -2, ["submit"]);
  if (fieldwork) {
    await fin.setEstimate(lead.userId, fieldwork.id, { categoryKey: "fieldwork", amount: "85000" });
    await fin.setEstimate(lead.userId, fieldwork.id, { categoryKey: "travel", amount: "30000" });
  }

  console.log(JSON.stringify({ email: lead.email, password, projectId: project.id, assistant: assistant.email, supervisor: supervisor.email }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
