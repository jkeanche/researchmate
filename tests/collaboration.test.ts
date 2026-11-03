import { AiService } from "@researchmate/ai";
import { CollaborationService } from "@researchmate/collaboration";
import { invitations, notifications, organizationMembers, projectMembers, reviewRequests, revisionTasks } from "@researchmate/database";
import { DocumentService } from "@researchmate/documents";
import { ProjectService } from "@researchmate/research";
import { addMemberByEmail } from "@researchmate/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, createUser, setPlan, testDb } from "./helpers";
import { type MockLlm, startMockLlm } from "./support/mock-llm";

let llm: MockLlm;
beforeAll(async () => (llm = await startMockLlm()));
afterAll(async () => {
  await llm.close();
  await closeTestDb();
});

const mail: { to: string; subject: string; text: string }[] = [];
const docs = () => new DocumentService(testDb(), { enqueueExport: async () => {} });
const collab = () => new CollaborationService(testDb(), { documents: docs(), appUrl: "https://rm.test", notify: async (to, subject, text) => void mail.push({ to, subject, text }) });
const tokenFrom = (link: string) => new URL(link).searchParams.get("token")!;
const lastMailTo = (to: string) => mail.filter((m) => m.to === to).at(-1);
const lastNotice = async (userId: string) => (await testDb().select().from(notifications).where(eq(notifications.userId, userId))).sort((a, b) => +a.createdAt - +b.createdAt).at(-1);

async function setup(plan = "research_pro") {
  const lead = await createUser("Lead Researcher");
  await setPlan(lead.orgId, plan);
  const project = await new ProjectService(testDb()).create(lead.userId, lead.orgId, { title: "Mobile money thesis", researchType: "masters_thesis", workflowTemplateKey: "" });
  const doc = await docs().create(lead.userId, project.id, { templateKey: "custom", title: "Chapter draft" });
  const main = (await docs().get(lead.userId, doc.id)).sections.find((s) => s.key === "main")!;
  await docs().saveSection(lead.userId, main.id, { content: "Households saved more.", version: main.version });
  return { lead, project, doc };
}

/** Invites a new person as supervisor and accepts with their own (newly registered) account. */
async function addSupervisor(lead: { userId: string }, projectId: string) {
  const sup = await createUser("Prof Supervisor");
  const { link } = await collab().invite(lead.userId, projectId, { email: sup.email, kind: "supervisor" });
  await collab().accept(sup.userId, tokenFrom(link));
  return sup;
}

describe("invitations", () => {
  it("invites by email; only the invited account can accept, once; supervisors join with limited access", async () => {
    const { lead, project } = await setup();
    const sup = await createUser("Prof Supervisor");
    const stranger = await createUser("Stranger");
    const { link, invitation } = await collab().invite(lead.userId, project.id, { email: sup.email.toUpperCase(), kind: "supervisor", supervisorKind: "co_supervisor", message: "Would you co-supervise?" });
    expect(invitation.email).toBe(sup.email);
    const sent = lastMailTo(sup.email)!;
    expect(sent.subject).toMatch(/invited you to supervise “Mobile money thesis”/);
    expect(sent.text).toContain(link);
    const [row] = await testDb().select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row!.tokenHash).not.toContain(tokenFrom(link)); // only a hash is stored

    expect(await collab().describe(tokenFrom(link))).toMatchObject({ status: "pending", projectTitle: "Mobile money thesis", invitedBy: "Lead Researcher", role: "project_supervisor" });
    await expect(collab().invite(lead.userId, project.id, { email: sup.email, kind: "supervisor" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(collab().invite(stranger.userId, project.id, { email: "x@example.org", kind: "supervisor" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(collab().accept(stranger.userId, tokenFrom(link))).rejects.toThrow(/sent to .* Sign in with that account/);

    const res = await collab().accept(sup.userId, tokenFrom(link));
    expect(res.projectId).toBe(project.id);
    const [om] = await testDb().select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, lead.orgId), eq(organizationMembers.userId, sup.userId)));
    expect(om!.roleKey).toBe("org_member");
    const [pm] = await testDb().select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, sup.userId)));
    expect(pm!.roleKey).toBe("project_supervisor");
    expect((await collab().supervisors(lead.userId, project.id)).map((s) => [s.name, s.kind])).toEqual([["Prof Supervisor", "co_supervisor"]]);
    await expect(collab().accept(sup.userId, tokenFrom(link))).rejects.toThrow(/already been accepted/);

    // Resend issues a new link; the old one stops working. Revoked links are refused.
    const other = await createUser("Collaborator");
    const first = await collab().invite(lead.userId, project.id, { email: other.email, kind: "collaborator", projectRoleKey: "project_assistant" });
    const second = await collab().resend(lead.userId, first.invitation.id);
    await expect(collab().accept(other.userId, tokenFrom(first.link))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await collab().revoke(lead.userId, first.invitation.id);
    await expect(collab().accept(other.userId, tokenFrom(second.link))).rejects.toThrow(/no longer valid/);

    // Expired
    const late = await collab().invite(lead.userId, project.id, { email: "late@example.org", kind: "collaborator", projectRoleKey: "project_viewer" });
    await testDb().update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, late.invitation.id));
    expect((await collab().describe(tokenFrom(late.link)))!.status).toBe("expired");
  });

  it("lists invitations for the verified account on its dashboard, where they can be accepted or declined", async () => {
    const { lead, project } = await setup();
    const sup = await createUser("Prof Dashboard");
    const other = await createUser("Someone Else");
    const { invitation } = await collab().invite(lead.userId, project.id, { email: sup.email, kind: "supervisor" });
    expect((await collab().pendingForUser(sup.userId)).map((i) => [i.id, i.projectTitle])).toEqual([[invitation.id, "Mobile money thesis"]]);
    expect(await collab().pendingForUser(other.userId)).toHaveLength(0);
    await expect(collab().acceptById(other.userId, invitation.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(collab().decline(other.userId, invitation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await collab().acceptById(sup.userId, invitation.id);
    expect(await collab().pendingForUser(sup.userId)).toHaveLength(0);
  });

  it("is gated by plan: none on Free, one supervisor on Starter, no collaborator invites on Starter", async () => {
    const free = await setup("free");
    await expect(collab().invite(free.lead.userId, free.project.id, { email: "s@example.org", kind: "supervisor" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    const starter = await setup("starter");
    await collab().invite(starter.lead.userId, starter.project.id, { email: "s1@example.org", kind: "supervisor" });
    await expect(collab().invite(starter.lead.userId, starter.project.id, { email: "s2@example.org", kind: "supervisor" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(collab().invite(starter.lead.userId, starter.project.id, { email: "c@example.org", kind: "collaborator", projectRoleKey: "project_researcher" })).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
  });
});

describe("reviews", () => {
  it("submission → feedback → changes requested → revisions answered and verified → resubmission approved", async () => {
    const { lead, project, doc } = await setup();
    await expect(collab().submit(lead.userId, doc.id, {})).rejects.toThrow(/Invite a supervisor/);
    const sup = await addSupervisor(lead, project.id);

    const r1 = await collab().submit(lead.userId, doc.id, { message: "Chapter 1 for comment", dueDate: "2026-12-01" });
    expect(r1).toMatchObject({ status: "submitted", round: 1 });
    expect(await lastNotice(sup.userId)).toMatchObject({ kind: "review.requested", title: "Review requested: “Chapter draft”", link: `/app/projects/${project.id}/reviews/${r1.id}`, emailStatus: "pending", projectId: project.id });
    await expect(collab().submit(lead.userId, doc.id, {})).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await collab().inbox(sup.userId)).map((r) => r.id)).toEqual([r1.id]);
    expect(await collab().inbox(lead.userId)).toHaveLength(0);

    // The submitter can't decide, even as a lead who holds the review permission; nor can the database be bypassed.
    await expect(collab().decide(lead.userId, r1.id, "approved")).rejects.toThrow(/your own submission/);
    await expect(testDb().update(reviewRequests).set({ status: "approved", decidedByUserId: lead.userId, decidedAt: new Date() }).where(eq(reviewRequests.id, r1.id))).rejects.toSatisfy((e: unknown) => /not_self/.test(String((e as { cause?: Error }).cause?.message ?? e)));

    await expect(collab().addComment(sup.userId, r1.id, { sectionKey: "nonexistent", body: "x" })).rejects.toThrow(/isn't in the submitted version/);
    await expect(collab().decide(sup.userId, r1.id, "changes_requested")).rejects.toThrow(/Explain what needs to change/);
    const c = await collab().addComment(sup.userId, r1.id, { sectionKey: "main", quote: "saved more", body: "Quantify the effect and cite the study.", severity: "major", createTask: true });
    expect(c.sectionTitle).toBe("Main Text");
    await collab().saveSummary(sup.userId, r1.id, "Good start; strengthen the evidence.");
    await collab().decide(sup.userId, r1.id, "changes_requested", "Please revise.");
    expect(await lastNotice(lead.userId)).toMatchObject({ kind: "review.decided", title: "Changes requested: “Chapter draft”", body: expect.stringContaining("Please revise.") });
    expect((await docs().get(lead.userId, doc.id)).document.status).toBe("draft");
    await expect(collab().decide(sup.userId, r1.id, "approved")).rejects.toMatchObject({ code: "FORBIDDEN" }); // already decided

    const view = await collab().get(lead.userId, r1.id);
    expect(view.tasks).toHaveLength(1);
    const task = view.tasks[0]!;
    expect(task).toMatchObject({ status: "open", sectionKey: "main", feedbackCommentId: c.id, assigneeUserId: lead.userId });
    await expect(collab().verify(lead.userId, task.id, true)).rejects.toThrow(/hasn't responded/);
    await expect(collab().respond(sup.userId, task.id, "addressed", "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(collab().respond(lead.userId, task.id, "declined", "  ")).rejects.toThrow(/Explain why/);
    await collab().respond(lead.userId, task.id, "addressed", "Added the 22% figure with a citation.");
    await collab().verify(sup.userId, task.id, false, "Also give the confidence interval.");
    await collab().respond(lead.userId, task.id, "addressed", "Added the interval.");
    await collab().verify(sup.userId, task.id, true);
    const [done] = await testDb().select().from(revisionTasks).where(eq(revisionTasks.id, task.id));
    expect(done).toMatchObject({ status: "verified", verifiedByUserId: sup.userId });
    expect(done!.response).toMatch(/Supervisor: Also give the confidence interval/);

    // Revision time runs from the decision to the resubmission.
    await testDb().update(reviewRequests).set({ createdAt: new Date(Date.now() - 6 * 86400000), decidedAt: new Date(Date.now() - 4 * 86400000) }).where(eq(reviewRequests.id, r1.id));
    const r2 = await collab().submit(lead.userId, doc.id, { reviewerUserId: sup.userId });
    expect(r2).toMatchObject({ round: 2, previousRequestId: r1.id });
    await collab().decide(sup.userId, r2.id, "approved", "Ready.");
    expect((await docs().get(lead.userId, doc.id)).document.status).toBe("final");
    const timing = await collab().timing(lead.userId, project.id);
    expect(timing).toMatchObject({ submissions: 2, awaiting: 0, openRevisionTasks: 0 });
    expect(timing.supervisorWaitingDays).toBeGreaterThanOrEqual(2);
    expect(timing.revisionDays).toBeGreaterThanOrEqual(3.9);
  });

  it("restricts reviews to the assigned reviewer; finance roles and outsiders see nothing", async () => {
    const { lead, project, doc } = await setup();
    const sup1 = await addSupervisor(lead, project.id);
    const sup2 = await addSupervisor(lead, project.id);
    const r = await collab().submit(lead.userId, doc.id, { reviewerUserId: sup1.userId });
    await expect(collab().addComment(sup2.userId, r.id, { body: "Not mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await collab().inbox(sup2.userId)).toHaveLength(0);
    const fin = await createUser("Finance");
    await addMemberByEmail(testDb(), lead.userId, lead.orgId, fin.email, "org_finance_manager");
    await expect(collab().get(fin.userId, r.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const outsider = await createUser("Outsider");
    await expect(collab().get(outsider.userId, r.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await collab().withdraw(lead.userId, r.id);
    await expect(collab().decide(sup1.userId, r.id, "approved")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the Supervisor Feedback Agent suggests revision tasks only; accepting one creates it", async () => {
    const { lead, project, doc } = await setup();
    const sup = await addSupervisor(lead, project.id);
    const r = await collab().submit(lead.userId, doc.id, {});
    await collab().addComment(sup.userId, r.id, { sectionKey: "main", body: "Define 'savings' precisely.", severity: "minor" });
    await collab().decide(sup.userId, r.id, "changes_requested");
    const ai = new AiService(testDb(), { enqueue: async () => {}, allowPrivateEndpoints: true });
    await ai.addCredential(lead.userId, lead.orgId, { providerKey: "openai_compatible", label: "Local", apiKey: "sk-test-0000", defaultModel: "mock-model", baseUrl: llm.url });
    const run = await ai.startRun(lead.userId, project.id, "supervisor-feedback", { reviewRequestId: r.id });
    llm.reply(JSON.stringify({ tasks: [{ title: "Define savings in Main Text", description: "Add a definition.", sectionKey: "main", commentIndex: 0 }, { title: "Tidy wording", description: "", sectionKey: "made_up", commentIndex: 7 }] }));
    await ai.processRun(run.id);
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("Define 'savings' precisely.");
    expect(sent).toContain("never suggest that anything is approved");
    const [listed] = await ai.listRuns(lead.userId, project.id);
    expect(listed!.suggestions.map((s) => [s.kind, s.payload.sectionKey, !!s.payload.feedbackCommentId])).toEqual([
      ["revision_task", "main", true],
      ["revision_task", null, false],
    ]);
    expect(await testDb().select().from(revisionTasks).where(eq(revisionTasks.reviewRequestId, r.id))).toHaveLength(0);
    await ai.decideSuggestion(lead.userId, listed!.suggestions[0]!.id, "accept");
    const tasks = await testDb().select().from(revisionTasks).where(eq(revisionTasks.reviewRequestId, r.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: "ai", status: "open", title: "Define savings in Main Text" });
    expect((await testDb().select().from(reviewRequests).where(eq(reviewRequests.id, r.id)))[0]!.status).toBe("changes_requested");
  });
});
