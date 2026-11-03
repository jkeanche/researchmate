import { randomBytes } from "node:crypto";
import {
  type Database,
  documents,
  documentVersions,
  invitations,
  organizationMembers,
  organizations,
  projectMembers,
  researchProjects,
  reviewRequests,
  revisionTasks,
  supervisorAssignments,
  supervisorFeedback,
  supervisorFeedbackComments,
  users,
  userProfiles,
} from "@researchmate/database";
import type { DocumentService } from "@researchmate/documents";
import { checkMemberQuota, getEntitlements, lockOrganization, tierOf } from "@researchmate/entitlements";
import { assertProjectWritable } from "@researchmate/research";
import { AppError, hmacHex, logger } from "@researchmate/shared";
import { getProjectAccess, notify, recordAudit, roleInfo } from "@researchmate/tenancy";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

export interface CollaborationDeps {
  documents: DocumentService;
  appUrl: string;
  /** Sends a plain-text email (queued in production). */
  notify?: (to: string, subject: string, text: string) => Promise<void>;
  invitationDays?: number;
}

const COLLABORATOR_ROLES = ["project_researcher", "project_assistant", "project_viewer"] as const;
const OPEN_REVIEW = ["submitted", "in_review"] as const;
const DAY = 86_400_000;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(320),
  kind: z.enum(["supervisor", "collaborator"]),
  projectRoleKey: z.enum(COLLABORATOR_ROLES).optional(),
  supervisorKind: z.enum(["primary", "co_supervisor", "examiner"]).default("primary"),
  message: z.string().trim().max(1000).default(""),
});

const days = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / DAY);

export class CollaborationService {
  constructor(
    private readonly db: Database,
    private readonly deps: CollaborationDeps,
  ) {}

  private async notify(to: string | null | undefined, subject: string, text: string) {
    if (!to || !this.deps.notify) return;
    try {
      await this.deps.notify(to, subject, text);
    } catch (err) {
      logger.warn("collaboration.notify_failed", { error: String(err) });
    }
  }

  private async tiers(organizationId: string) {
    const ent = await getEntitlements(this.db, organizationId);
    return { supervisor: tierOf(ent, "collaboration.supervisor"), team: tierOf(ent, "collaboration.team"), planName: ent.planName };
  }

  /** On the "limited" tier a project can have one supervisor (active or invited). */
  private async assertSupervisorAllowed(organizationId: string, projectId: string) {
    const t = await this.tiers(organizationId);
    if (t.supervisor === "none") throw new AppError("FEATURE_NOT_ENTITLED", `Supervisor collaboration is not included in the ${t.planName} plan.`, { feature: "collaboration.supervisor" });
    if (t.supervisor === "limited") {
      const [{ n }] = (await this.db.execute<{ n: number }>(sql`
        select (select count(*) from supervisor_assignments where project_id = ${projectId} and ended_at is null)
             + (select count(*) from invitations where project_id = ${projectId} and status = 'pending' and project_role_key = 'project_supervisor' and expires_at > now()) as n`)) as unknown as [{ n: number }];
      if (Number(n) >= 1) throw new AppError("QUOTA_EXCEEDED", `The ${t.planName} plan includes one supervisor per project.`, { feature: "collaboration.supervisor" });
    }
  }

  private async userName(userId: string | null) {
    if (!userId) return "Someone";
    const [p] = await this.db.select({ n: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, userId));
    return p?.n ?? "Someone";
  }

  // ----- Invitations -------------------------------------------------------

  async invite(actorUserId: string, projectId: string, input: unknown) {
    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]!.message);
    const d = parsed.data;
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has("project.members.manage")) throw new AppError("FORBIDDEN", "Only the project lead can invite people.");
    await assertProjectWritable(this.db, projectId);
    if (d.kind === "supervisor") await this.assertSupervisorAllowed(access.organizationId, projectId);
    else {
      const t = await this.tiers(access.organizationId);
      if (t.team === "none") throw new AppError("FEATURE_NOT_ENTITLED", `Inviting collaborators is not included in the ${t.planName} plan.`, { feature: "collaboration.team" });
      if (!d.projectRoleKey) throw new AppError("VALIDATION", "Choose a role.");
    }
    const projectRoleKey = d.kind === "supervisor" ? "project_supervisor" : d.projectRoleKey!;
    // Already on the project in that role?
    const [existing] = await this.db
      .select({ role: projectMembers.roleKey })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, projectId), eq(users.email, d.email)));
    if (existing?.role === projectRoleKey) throw new AppError("CONFLICT", "That person already has this role on the project.");
    if (existing?.role === "project_lead") throw new AppError("CONFLICT", "That person leads this project.");

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + (this.deps.invitationDays ?? 14) * DAY);
    let row;
    try {
      [row] = await this.db
        .insert(invitations)
        .values({ organizationId: access.organizationId, projectId, email: d.email, orgRoleKey: "org_member", projectRoleKey, supervisorKind: d.kind === "supervisor" ? d.supervisorKind : null, tokenHash: hmacHex(`invite:${token}`), message: d.message, invitedByUserId: actorUserId, expiresAt })
        .returning();
    } catch (err) {
      if (String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code) === "23505") throw new AppError("CONFLICT", "An invitation to that address is already open. Resend it instead.");
      throw err;
    }
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "invitation.created", targetType: "project", targetId: projectId, metadata: { invitationId: row!.id, role: projectRoleKey } });
    const link = await this.sendInvitation(row!, token);
    return { invitation: row!, link };
  }

  private async sendInvitation(inv: typeof invitations.$inferSelect, token: string) {
    const link = `${this.deps.appUrl.replace(/\/$/, "")}/invite?token=${token}`;
    const [p] = inv.projectId ? await this.db.select({ title: researchProjects.title }).from(researchProjects).where(eq(researchProjects.id, inv.projectId)) : [];
    const [o] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.organizationId));
    const who = await this.userName(inv.invitedByUserId);
    const role = inv.projectRoleKey === "project_supervisor" ? "supervise" : "collaborate on";
    await this.notify(
      inv.email,
      `${who} invited you to ${role} “${p?.title ?? o?.name}” on ResearchMate`,
      `${who} invited you to ${role} the research project “${p?.title ?? ""}” in ${o?.name ?? "their workspace"} on ResearchMate.${inv.message ? `\n\nTheir message:\n${inv.message}` : ""}\n\nAccept the invitation (you can create a free account with this email address):\n${link}\n\nThe link expires on ${inv.expiresAt.toUTCString()}. If you weren't expecting this, you can ignore this email.`,
    );
    return link;
  }

  async listInvitations(actorUserId: string, projectId: string) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has("project.members.manage")) return [];
    await this.db.update(invitations).set({ status: "expired" }).where(and(eq(invitations.projectId, projectId), eq(invitations.status, "pending"), sql`${invitations.expiresAt} < now()`));
    return this.db.select().from(invitations).where(and(eq(invitations.projectId, projectId), eq(invitations.status, "pending"))).orderBy(desc(invitations.createdAt));
  }

  private async manageable(actorUserId: string, invitationId: string) {
    const [inv] = await this.db.select().from(invitations).where(eq(invitations.id, invitationId));
    if (!inv?.projectId) throw new AppError("NOT_FOUND", "Invitation not found.");
    const access = await getProjectAccess(this.db, actorUserId, inv.projectId);
    if (!access.permissions.has("project.members.manage")) throw new AppError("FORBIDDEN", "Only the project lead can manage invitations.");
    return inv;
  }

  async revoke(actorUserId: string, invitationId: string) {
    const inv = await this.manageable(actorUserId, invitationId);
    if (inv.status !== "pending") throw new AppError("CONFLICT", "This invitation is no longer open.");
    await this.db.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, invitationId));
  }

  /** Issues a new link (the old one stops working) and extends the expiry. */
  async resend(actorUserId: string, invitationId: string) {
    const inv = await this.manageable(actorUserId, invitationId);
    if (inv.status !== "pending" && inv.status !== "expired") throw new AppError("CONFLICT", "This invitation is no longer open.");
    const token = randomBytes(32).toString("base64url");
    const [row] = await this.db.update(invitations).set({ tokenHash: hmacHex(`invite:${token}`), status: "pending", expiresAt: new Date(Date.now() + (this.deps.invitationDays ?? 14) * DAY) }).where(eq(invitations.id, invitationId)).returning();
    return { link: await this.sendInvitation(row!, token) };
  }

  private async byToken(token: string) {
    if (!token || token.length > 100) return null;
    const [inv] = await this.db.select().from(invitations).where(eq(invitations.tokenHash, hmacHex(`invite:${token}`)));
    return inv ?? null;
  }

  /** What the invitation page shows before the person signs in. */
  async describe(token: string) {
    const inv = await this.byToken(token);
    if (!inv) return null;
    const [p] = inv.projectId ? await this.db.select({ title: researchProjects.title }).from(researchProjects).where(eq(researchProjects.id, inv.projectId)) : [];
    const [o] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.organizationId));
    const status = inv.status === "pending" && inv.expiresAt < new Date() ? "expired" : inv.status;
    return { email: inv.email, status, projectTitle: p?.title ?? null, organizationName: o?.name ?? "", invitedBy: await this.userName(inv.invitedByUserId), role: inv.projectRoleKey, supervisorKind: inv.supervisorKind, message: inv.message, expiresAt: inv.expiresAt };
  }

  /** Accepts as the signed-in user, whose (verified) email must be the invited address. */
  async accept(userId: string, token: string) {
    const inv = await this.byToken(token);
    if (!inv) throw new AppError("NOT_FOUND", "This invitation link isn't valid. Ask for a new one.");
    return this.acceptInvitation(userId, inv);
  }

  /** Open invitations addressed to this user's (verified) email, for the dashboard. */
  async pendingForUser(userId: string) {
    const [u] = await this.db.select({ email: users.email, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
    if (!u?.verified) return [];
    return this.db
      .select({ id: invitations.id, projectTitle: researchProjects.title, organizationName: organizations.name, role: invitations.projectRoleKey, message: invitations.message, invitedBy: userProfiles.displayName, expiresAt: invitations.expiresAt })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .leftJoin(researchProjects, eq(researchProjects.id, invitations.projectId))
      .leftJoin(userProfiles, eq(userProfiles.userId, invitations.invitedByUserId))
      .where(and(eq(invitations.email, u.email.toLowerCase()), eq(invitations.status, "pending"), sql`${invitations.expiresAt} > now()`));
  }

  async acceptById(userId: string, invitationId: string) {
    const [inv] = await this.db.select().from(invitations).where(eq(invitations.id, invitationId));
    if (!inv) throw new AppError("NOT_FOUND", "Invitation not found.");
    return this.acceptInvitation(userId, inv);
  }

  async decline(userId: string, invitationId: string) {
    const [inv] = await this.db.select().from(invitations).where(eq(invitations.id, invitationId));
    const [u] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!inv || !u || inv.email !== u.email.toLowerCase() || inv.status !== "pending") throw new AppError("NOT_FOUND", "Invitation not found.");
    await this.db.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, invitationId));
  }

  private async acceptInvitation(userId: string, inv: typeof invitations.$inferSelect) {
    if (inv.status !== "pending") throw new AppError("CONFLICT", inv.status === "accepted" ? "This invitation has already been accepted." : "This invitation is no longer valid. Ask for a new one.");
    if (inv.expiresAt < new Date()) throw new AppError("CONFLICT", "This invitation has expired. Ask for a new one.");
    const [u] = await this.db.select({ email: users.email, verified: users.emailVerifiedAt, status: users.status }).from(users).where(eq(users.id, userId));
    if (!u || u.status !== "active") throw new AppError("FORBIDDEN", "Your account can't accept invitations.");
    if (u.email.toLowerCase() !== inv.email) throw new AppError("FORBIDDEN", `This invitation was sent to ${inv.email}. Sign in with that account to accept it.`);
    if (!u.verified) throw new AppError("FORBIDDEN", "Verify your email address first.");
    return this.db.transaction(async (tx) => {
      await lockOrganization(tx, inv.organizationId);
      const [again] = await tx.select({ status: invitations.status }).from(invitations).where(eq(invitations.id, inv.id)).for("update");
      if (again?.status !== "pending") throw new AppError("CONFLICT", "This invitation has already been used.");
      const [member] = await tx.select({ role: organizationMembers.roleKey }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, inv.organizationId), eq(organizationMembers.userId, userId)));
      if (!member) {
        await checkMemberQuota(tx, inv.organizationId);
        await tx.insert(organizationMembers).values({ organizationId: inv.organizationId, userId, roleKey: inv.orgRoleKey });
      }
      if (inv.projectId && inv.projectRoleKey) {
        const info = await roleInfo(tx, inv.projectRoleKey);
        if (!info || info.scope !== "project") throw new AppError("VALIDATION", "Unknown role.");
        const [pm] = await tx.select({ role: projectMembers.roleKey }).from(projectMembers).where(and(eq(projectMembers.projectId, inv.projectId), eq(projectMembers.userId, userId)));
        // Never demote a lead through an invitation.
        if (pm?.role !== "project_lead") await tx.insert(projectMembers).values({ projectId: inv.projectId, userId, roleKey: inv.projectRoleKey }).onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleKey: inv.projectRoleKey } });
        if (inv.projectRoleKey === "project_supervisor") await tx.insert(supervisorAssignments).values({ projectId: inv.projectId, userId, kind: inv.supervisorKind ?? "primary", assignedByUserId: inv.invitedByUserId }).onConflictDoNothing();
      }
      await tx.update(invitations).set({ status: "accepted", acceptedAt: new Date(), acceptedByUserId: userId }).where(eq(invitations.id, inv.id));
      await recordAudit(tx, { organizationId: inv.organizationId, actorUserId: userId, action: "invitation.accepted", targetType: "project", targetId: inv.projectId ?? inv.organizationId, metadata: { invitationId: inv.id, role: inv.projectRoleKey } });
      return { organizationId: inv.organizationId, projectId: inv.projectId };
    });
  }

  // ----- Supervisors -------------------------------------------------------

  async supervisors(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    return this.db
      .select({ id: supervisorAssignments.id, userId: supervisorAssignments.userId, kind: supervisorAssignments.kind, since: supervisorAssignments.createdAt, name: userProfiles.displayName, email: users.email })
      .from(supervisorAssignments)
      .innerJoin(users, eq(users.id, supervisorAssignments.userId))
      .leftJoin(userProfiles, eq(userProfiles.userId, supervisorAssignments.userId))
      .where(and(eq(supervisorAssignments.projectId, projectId), isNull(supervisorAssignments.endedAt)))
      .orderBy(asc(supervisorAssignments.createdAt));
  }

  /** Makes an existing organization member a supervisor of the project. */
  async assignSupervisor(actorUserId: string, projectId: string, userId: string, kind = "primary", members: { add: (a: string, p: string, u: string, r: string) => Promise<void> }) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has("project.members.manage")) throw new AppError("FORBIDDEN", "Only the project lead can assign supervisors.");
    if (userId === actorUserId) throw new AppError("VALIDATION", "You can't supervise your own project.");
    await this.assertSupervisorAllowed(access.organizationId, projectId);
    await members.add(actorUserId, projectId, userId, "project_supervisor");
    await this.db.insert(supervisorAssignments).values({ projectId, userId, kind, assignedByUserId: actorUserId }).onConflictDoNothing();
  }

  async endSupervision(actorUserId: string, assignmentId: string) {
    const [a] = await this.db.select().from(supervisorAssignments).where(eq(supervisorAssignments.id, assignmentId));
    if (!a) throw new AppError("NOT_FOUND", "Not found.");
    const access = await getProjectAccess(this.db, actorUserId, a.projectId);
    if (!access.permissions.has("project.members.manage")) throw new AppError("FORBIDDEN", "Only the project lead can change supervisors.");
    await this.db.update(supervisorAssignments).set({ endedAt: new Date() }).where(eq(supervisorAssignments.id, assignmentId));
  }

  // ----- Reviews -----------------------------------------------------------

  private async reviewers(projectId: string, excludeUserId: string) {
    const rows = await this.db.execute<{ user_id: string; email: string }>(sql`
      select pm.user_id, u.email from project_members pm
      join users u on u.id = pm.user_id
      join role_permissions rp on rp.role_key = pm.role_key and rp.permission_key = 'project.review'
      where pm.project_id = ${projectId} and pm.user_id <> ${excludeUserId}`);
    return rows as unknown as { user_id: string; email: string }[];
  }

  /** Submits a snapshot of the document for review (optionally with a PDF rendered from it). */
  async submit(actorUserId: string, documentId: string, input: { reviewerUserId?: string | null; message?: string; dueDate?: string | null; attachPdf?: boolean }) {
    const [doc] = await this.db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) throw new AppError("NOT_FOUND", "Document not found.");
    const access = await getProjectAccess(this.db, actorUserId, doc.projectId);
    if (!access.permissions.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to submit documents.");
    await assertProjectWritable(this.db, doc.projectId);
    const t = await this.tiers(access.organizationId);
    if (t.supervisor === "none") throw new AppError("FEATURE_NOT_ENTITLED", `Supervisor collaboration is not included in the ${t.planName} plan.`, { feature: "collaboration.supervisor" });
    const reviewers = await this.reviewers(doc.projectId, actorUserId);
    if (!reviewers.length) throw new AppError("VALIDATION", "Invite a supervisor to the project before submitting.");
    const reviewerUserId = input.reviewerUserId || null;
    if (reviewerUserId && !reviewers.some((r) => r.user_id === reviewerUserId)) throw new AppError("VALIDATION", "Choose one of the project's supervisors.");
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new AppError("VALIDATION", "Enter the date as YYYY-MM-DD.");
    const open = await this.db.select({ id: reviewRequests.id }).from(reviewRequests).where(and(eq(reviewRequests.documentId, documentId), inArray(reviewRequests.status, [...OPEN_REVIEW])));
    if (open.length) throw new AppError("CONFLICT", "This document is already waiting for review. Withdraw that submission to send a newer version.");
    const [prev] = await this.db.select().from(reviewRequests).where(eq(reviewRequests.documentId, documentId)).orderBy(desc(reviewRequests.createdAt)).limit(1);

    let versionId: string;
    let exportId: string | null = null;
    if (input.attachPdf) {
      const x = await this.deps.documents.requestExport(actorUserId, documentId, "pdf");
      versionId = x.versionId;
      exportId = x.id;
    } else versionId = (await this.deps.documents.saveVersion(actorUserId, documentId, "Submitted for review")).id;

    const [row] = await this.db
      .insert(reviewRequests)
      .values({ projectId: doc.projectId, documentId, versionId, exportId, previousRequestId: prev?.id ?? null, round: (prev?.round ?? 0) + 1, submittedByUserId: actorUserId, reviewerUserId, message: String(input.message ?? "").slice(0, 2000), dueDate: input.dueDate || null })
      .returning();
    await this.db.update(documents).set({ status: "in_review", updatedAt: new Date() }).where(eq(documents.id, documentId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "review.submitted", targetType: "project", targetId: doc.projectId, metadata: { reviewRequestId: row!.id, documentId, round: row!.round } });
    const who = await this.userName(actorUserId);
    // In-app and (per preference) email, delivered by the notifications worker.
    await notify(this.db, {
      userIds: reviewers.filter((r) => !reviewerUserId || r.user_id === reviewerUserId).map((r) => r.user_id as string),
      kind: "review.requested",
      title: `Review requested: “${doc.title}”`,
      body: `${who} submitted “${doc.title}” (round ${row!.round}) for your review.${row!.message ? `\n\n${row!.message}` : ""}${row!.dueDate ? `\n\nRequested by ${row!.dueDate}.` : ""}`,
      link: `/app/projects/${doc.projectId}/reviews/${row!.id}`,
      organizationId: access.organizationId,
      projectId: doc.projectId,
    });
    return row!;
  }

  async list(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    const rows = await this.db
      .select({ r: reviewRequests, title: documents.title, submitter: userProfiles.displayName })
      .from(reviewRequests)
      .innerJoin(documents, eq(documents.id, reviewRequests.documentId))
      .leftJoin(userProfiles, eq(userProfiles.userId, reviewRequests.submittedByUserId))
      .where(eq(reviewRequests.projectId, projectId))
      .orderBy(desc(reviewRequests.createdAt));
    const now = new Date();
    return rows.map((x) => ({ ...x, waitingDays: x.r.status === "withdrawn" ? null : days(x.r.createdAt, x.r.decidedAt ?? now) }));
  }

  /** Reviews waiting for this person, across all their projects. */
  async inbox(userId: string) {
    const rows = await this.db.execute<{ id: string; project_id: string; project_title: string; title: string; status: string; created_at: Date; due_date: string | null; round: number }>(sql`
      select rr.id, rr.project_id, p.title as project_title, d.title, rr.status, rr.created_at, rr.due_date, rr.round
      from review_requests rr
      join documents d on d.id = rr.document_id
      join research_projects p on p.id = rr.project_id
      join project_members pm on pm.project_id = rr.project_id and pm.user_id = ${userId}
      join role_permissions rp on rp.role_key = pm.role_key and rp.permission_key = 'project.review'
      where rr.status in ('submitted', 'in_review')
        and (rr.reviewer_user_id is null or rr.reviewer_user_id = ${userId})
        and rr.submitted_by_user_id is distinct from ${userId}
      order by rr.created_at`);
    return rows as unknown as { id: string; project_id: string; project_title: string; title: string; status: string; created_at: Date; due_date: string | null; round: number }[];
  }

  private async request(actorUserId: string, requestId: string) {
    const [r] = await this.db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId));
    if (!r) throw new AppError("NOT_FOUND", "Review not found.");
    const access = await getProjectAccess(this.db, actorUserId, r.projectId);
    const p = access.permissions;
    if (!p.has("project.update") && !p.has("project.review")) throw new AppError("NOT_FOUND", "Review not found.");
    const open = (OPEN_REVIEW as readonly string[]).includes(r.status);
    const canReview = open && p.has("project.review") && r.submittedByUserId !== actorUserId && (!r.reviewerUserId || r.reviewerUserId === actorUserId);
    return { r, access, canReview, canEdit: p.has("project.update"), canVerify: p.has("project.review") };
  }

  async get(actorUserId: string, requestId: string) {
    const { r, canReview, canEdit, canVerify, access } = await this.request(actorUserId, requestId);
    const [[doc], [version], feedback, comments, tasks] = await Promise.all([
      this.db.select().from(documents).where(eq(documents.id, r.documentId)),
      this.db.select().from(documentVersions).where(eq(documentVersions.id, r.versionId)),
      this.db.select({ f: supervisorFeedback, author: userProfiles.displayName }).from(supervisorFeedback).leftJoin(userProfiles, eq(userProfiles.userId, supervisorFeedback.authorUserId)).where(eq(supervisorFeedback.reviewRequestId, requestId)).orderBy(asc(supervisorFeedback.createdAt)),
      this.db
        .select({ c: supervisorFeedbackComments, author: userProfiles.displayName, authorUserId: supervisorFeedback.authorUserId })
        .from(supervisorFeedbackComments)
        .innerJoin(supervisorFeedback, eq(supervisorFeedback.id, supervisorFeedbackComments.feedbackId))
        .leftJoin(userProfiles, eq(userProfiles.userId, supervisorFeedback.authorUserId))
        .where(eq(supervisorFeedback.reviewRequestId, requestId))
        .orderBy(asc(supervisorFeedbackComments.createdAt)),
      this.db.select().from(revisionTasks).where(eq(revisionTasks.reviewRequestId, requestId)).orderBy(asc(revisionTasks.createdAt)),
    ]);
    const names = new Map<string, string>();
    for (const id of [r.submittedByUserId, r.reviewerUserId, r.decidedByUserId]) if (id && !names.has(id)) names.set(id, await this.userName(id));
    return { request: r, document: doc!, version: version!, feedback, comments, tasks, names, canReview, canEdit: canEdit && r.status !== "withdrawn", canVerify, organizationId: access.organizationId, actorUserId };
  }

  async startReview(actorUserId: string, requestId: string) {
    const { r, canReview } = await this.request(actorUserId, requestId);
    if (!canReview) throw new AppError("FORBIDDEN", "You can't review this submission.");
    if (r.status === "submitted") await this.db.update(reviewRequests).set({ status: "in_review", startedAt: new Date() }).where(and(eq(reviewRequests.id, requestId), eq(reviewRequests.status, "submitted")));
  }

  private async feedbackRow(r: typeof reviewRequests.$inferSelect, authorUserId: string) {
    const [f] = await this.db.insert(supervisorFeedback).values({ projectId: r.projectId, reviewRequestId: r.id, authorUserId }).onConflictDoNothing().returning();
    if (f) return f;
    const [existing] = await this.db.select().from(supervisorFeedback).where(and(eq(supervisorFeedback.reviewRequestId, r.id), eq(supervisorFeedback.authorUserId, authorUserId)));
    return existing!;
  }

  async saveSummary(actorUserId: string, requestId: string, summary: string) {
    const { r, canReview } = await this.request(actorUserId, requestId);
    if (!canReview) throw new AppError("FORBIDDEN", "You can't review this submission.");
    const f = await this.feedbackRow(r, actorUserId);
    await this.db.update(supervisorFeedback).set({ summary: summary.trim().slice(0, 10_000), updatedAt: new Date() }).where(eq(supervisorFeedback.id, f.id));
    await this.startReview(actorUserId, requestId);
  }

  async addComment(actorUserId: string, requestId: string, input: { sectionKey?: string | null; quote?: string; body: string; severity?: string; createTask?: boolean }) {
    const { r, canReview } = await this.request(actorUserId, requestId);
    if (!canReview) throw new AppError("FORBIDDEN", "You can't review this submission.");
    const body = String(input.body ?? "").trim();
    if (!body || body.length > 5000) throw new AppError("VALIDATION", "Write the comment (up to 5,000 characters).");
    const severity = input.severity && ["minor", "major", "critical"].includes(input.severity) ? input.severity : "minor";
    const [v] = await this.db.select({ snapshot: documentVersions.snapshot }).from(documentVersions).where(eq(documentVersions.id, r.versionId));
    const section = input.sectionKey ? v!.snapshot.sections.find((s) => s.key === input.sectionKey) : undefined;
    if (input.sectionKey && !section) throw new AppError("VALIDATION", "That section isn't in the submitted version.");
    const f = await this.feedbackRow(r, actorUserId);
    const [c] = await this.db.insert(supervisorFeedbackComments).values({ feedbackId: f.id, sectionKey: section?.key ?? null, sectionTitle: section?.title ?? "", quote: String(input.quote ?? "").slice(0, 1000), body, severity }).returning();
    if (input.createTask) await this.db.insert(revisionTasks).values({ projectId: r.projectId, documentId: r.documentId, reviewRequestId: r.id, feedbackCommentId: c!.id, title: body.split(/\n/)[0]!.slice(0, 200), description: body, sectionKey: section?.key ?? null, assigneeUserId: r.submittedByUserId, createdByUserId: actorUserId });
    await this.startReview(actorUserId, requestId);
    return c!;
  }

  /**
   * A supervisor's decision. Requesting changes needs written feedback;
   * approval is never automatic and never by the submitter.
   */
  async decide(actorUserId: string, requestId: string, decision: "approved" | "changes_requested", note = "") {
    const { r, canReview, access } = await this.request(actorUserId, requestId);
    if (!canReview) throw new AppError("FORBIDDEN", r.submittedByUserId === actorUserId ? "You can't decide on your own submission." : "You can't review this submission.");
    if (decision !== "approved" && decision !== "changes_requested") throw new AppError("VALIDATION", "Choose approve or request changes.");
    if (decision === "changes_requested") {
      const [{ n }] = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from supervisor_feedback_comments c join supervisor_feedback f on f.id = c.feedback_id where f.review_request_id = ${requestId}`)) as unknown as [{ n: number }];
      const [f] = await this.db.select({ s: supervisorFeedback.summary }).from(supervisorFeedback).where(eq(supervisorFeedback.reviewRequestId, requestId));
      if (!Number(n) && !f?.s.trim() && !note.trim()) throw new AppError("VALIDATION", "Explain what needs to change: add comments, a summary or a note.");
    }
    const [row] = await this.db
      .update(reviewRequests)
      .set({ status: decision, decidedByUserId: actorUserId, decidedAt: new Date(), decisionNote: note.trim().slice(0, 5000), startedAt: r.startedAt ?? new Date() })
      .where(and(eq(reviewRequests.id, requestId), inArray(reviewRequests.status, [...OPEN_REVIEW])))
      .returning();
    if (!row) throw new AppError("CONFLICT", "This submission has already been decided.");
    await this.db.update(documents).set({ status: decision === "approved" ? "final" : "draft", updatedAt: new Date() }).where(eq(documents.id, r.documentId));
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: `review.${decision}`, targetType: "project", targetId: r.projectId, metadata: { reviewRequestId: requestId } });
    const [doc] = await this.db.select({ title: documents.title }).from(documents).where(eq(documents.id, r.documentId));
    const who = await this.userName(actorUserId);
    await notify(this.db, {
      userIds: [r.submittedByUserId],
      kind: "review.decided",
      title: decision === "approved" ? `Approved: “${doc!.title}”` : `Changes requested: “${doc!.title}”`,
      body: `${who} ${decision === "approved" ? "approved" : "requested changes to"} “${doc!.title}” (round ${r.round}).${note ? `\n\n${note}` : ""}`,
      link: `/app/projects/${r.projectId}/reviews/${r.id}`,
      organizationId: access.organizationId,
      projectId: r.projectId,
    });
    return row;
  }

  async withdraw(actorUserId: string, requestId: string) {
    const { r, canEdit } = await this.request(actorUserId, requestId);
    if (!canEdit) throw new AppError("FORBIDDEN", "You can't withdraw this submission.");
    const [row] = await this.db.update(reviewRequests).set({ status: "withdrawn" }).where(and(eq(reviewRequests.id, requestId), inArray(reviewRequests.status, [...OPEN_REVIEW]))).returning();
    if (!row) throw new AppError("CONFLICT", "Only submissions still waiting for a decision can be withdrawn.");
    await this.db.update(documents).set({ status: "draft" }).where(eq(documents.id, r.documentId));
  }

  // ----- Revision tasks ----------------------------------------------------

  async revisions(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    return this.db
      .select({ t: revisionTasks, document: documents.title, round: reviewRequests.round, assignee: userProfiles.displayName })
      .from(revisionTasks)
      .leftJoin(documents, eq(documents.id, revisionTasks.documentId))
      .leftJoin(reviewRequests, eq(reviewRequests.id, revisionTasks.reviewRequestId))
      .leftJoin(userProfiles, eq(userProfiles.userId, revisionTasks.assigneeUserId))
      .where(eq(revisionTasks.projectId, projectId))
      .orderBy(asc(revisionTasks.status), desc(revisionTasks.createdAt));
  }

  async createRevision(actorUserId: string, requestId: string, input: { title: string; description?: string; sectionKey?: string | null; dueDate?: string | null; feedbackCommentId?: string | null }, source: "manual" | "ai" = "manual") {
    const { r, canEdit, canVerify } = await this.request(actorUserId, requestId);
    if (!canEdit && !canVerify) throw new AppError("FORBIDDEN", "You can't add revision tasks here.");
    await assertProjectWritable(this.db, r.projectId);
    const title = String(input.title ?? "").trim();
    if (title.length < 3 || title.length > 200) throw new AppError("VALIDATION", "Give the task a title (3–200 characters).");
    if (input.feedbackCommentId) {
      const [c] = await this.db.select({ req: supervisorFeedback.reviewRequestId }).from(supervisorFeedbackComments).innerJoin(supervisorFeedback, eq(supervisorFeedback.id, supervisorFeedbackComments.feedbackId)).where(eq(supervisorFeedbackComments.id, input.feedbackCommentId));
      if (c?.req !== requestId) throw new AppError("VALIDATION", "That comment belongs to another review.");
    }
    const [row] = await this.db
      .insert(revisionTasks)
      .values({ projectId: r.projectId, documentId: r.documentId, reviewRequestId: r.id, feedbackCommentId: input.feedbackCommentId || null, title, description: String(input.description ?? "").slice(0, 5000), sectionKey: input.sectionKey || null, dueDate: input.dueDate || null, assigneeUserId: r.submittedByUserId, source, createdByUserId: actorUserId })
      .returning();
    return row!;
  }

  private async task(actorUserId: string, taskId: string) {
    const [t] = await this.db.select().from(revisionTasks).where(eq(revisionTasks.id, taskId));
    if (!t) throw new AppError("NOT_FOUND", "Task not found.");
    const access = await getProjectAccess(this.db, actorUserId, t.projectId);
    await assertProjectWritable(this.db, t.projectId);
    return { t, p: access.permissions };
  }

  /** The researcher addresses (or declines, with a reason) a revision task. */
  async respond(actorUserId: string, taskId: string, status: "addressed" | "declined", response: string) {
    const { t, p } = await this.task(actorUserId, taskId);
    if (!p.has("project.update")) throw new AppError("FORBIDDEN", "Only the research team responds to revision tasks.");
    if (!["open", "reopened"].includes(t.status)) throw new AppError("CONFLICT", "This task has already been answered.");
    if (status === "declined" && !response.trim()) throw new AppError("VALIDATION", "Explain why this change won't be made.");
    // Responses accumulate, so the exchange with the supervisor stays readable.
    const combined = (t.response ? `${t.response}\n\nResearcher: ${response.trim()}` : response.trim()).slice(-5000);
    await this.db.update(revisionTasks).set({ status, response: combined, addressedAt: new Date(), updatedAt: new Date() }).where(eq(revisionTasks.id, taskId));
  }

  /** Only a supervisor verifies a response or reopens the task. */
  async verify(actorUserId: string, taskId: string, accept: boolean, note = "") {
    const { t, p } = await this.task(actorUserId, taskId);
    if (!p.has("project.review")) throw new AppError("FORBIDDEN", "Only a supervisor can verify revisions.");
    if (!["addressed", "declined"].includes(t.status)) throw new AppError("CONFLICT", "The researcher hasn't responded yet.");
    await this.db
      .update(revisionTasks)
      .set(accept ? { status: "verified", verifiedByUserId: actorUserId, verifiedAt: new Date(), updatedAt: new Date() } : { status: "reopened", response: note.trim() ? `${t.response}\n\nSupervisor: ${note.trim()}`.slice(0, 5000) : t.response, updatedAt: new Date() })
      .where(eq(revisionTasks.id, taskId));
  }

  // ----- Measures ----------------------------------------------------------

  /**
   * Supervisor waiting time (submitted → decided, or until now) and revision
   * time (changes requested → next submission), tracked separately as the
   * blueprint asks.
   */
  async timing(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    const rows = await this.db.select().from(reviewRequests).where(and(eq(reviewRequests.projectId, projectId), ne(reviewRequests.status, "withdrawn"))).orderBy(asc(reviewRequests.createdAt));
    const now = new Date();
    let waiting = 0;
    let revising = 0;
    let longestOpen = 0;
    for (const r of rows) {
      const w = days(r.createdAt, r.decidedAt ?? now);
      waiting += w;
      if (!r.decidedAt) longestOpen = Math.max(longestOpen, w);
      if (r.status === "changes_requested" && r.decidedAt) {
        const next = rows.find((x) => x.previousRequestId === r.id);
        revising += days(r.decidedAt, next?.createdAt ?? now);
      }
    }
    const decided = rows.filter((r) => r.decidedAt);
    const open = await this.db.select({ n: sql<number>`count(*)::int` }).from(revisionTasks).where(and(eq(revisionTasks.projectId, projectId), or(eq(revisionTasks.status, "open"), eq(revisionTasks.status, "reopened"))));
    return {
      submissions: rows.length,
      awaiting: rows.filter((r) => !r.decidedAt).length,
      supervisorWaitingDays: Math.round(waiting * 10) / 10,
      revisionDays: Math.round(revising * 10) / 10,
      averageTurnaroundDays: decided.length ? Math.round((decided.reduce((a, r) => a + days(r.createdAt, r.decidedAt!), 0) / decided.length) * 10) / 10 : null,
      longestOpenDays: Math.round(longestOpen * 10) / 10,
      openRevisionTasks: open[0]?.n ?? 0,
    };
  }
}
