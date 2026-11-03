"use server";

import { AppError } from "@researchmate/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { collaborationService, memberService } from "../services";
import { requireSession } from "../session";

/** Invitations, supervisors and reviews. Every rule is enforced in CollaborationService. */
export async function collaborationAction(_: FormState, form: FormData): Promise<FormState> {
  let target = "";
  const r = await handle(async () => {
    const s = await requireSession();
    const uid = s.user.id;
    const projectId = str(form, "projectId");
    const c = await collaborationService();
    const done = (msg: string, ...paths: string[]) => {
      for (const p of paths.length ? paths : [`/app/projects/${projectId}`]) revalidatePath(p, "layout");
      return { success: msg };
    };
    switch (str(form, "intent")) {
      case "invite": {
        const kind = str(form, "kind") === "collaborator" ? "collaborator" : "supervisor";
        const { invitation } = await c.invite(uid, projectId, { email: str(form, "email"), kind, projectRoleKey: str(form, "projectRoleKey") || undefined, supervisorKind: str(form, "supervisorKind") || undefined, message: str(form, "message") });
        return done(`Invitation sent to ${invitation.email}.`);
      }
      case "resend":
        await c.resend(uid, str(form, "invitationId"));
        return done("A new invitation link was sent. The old link no longer works.");
      case "revoke":
        await c.revoke(uid, str(form, "invitationId"));
        return done("Invitation withdrawn.");
      case "assign_supervisor":
        await c.assignSupervisor(uid, projectId, str(form, "userId"), str(form, "supervisorKind") || "primary", memberService());
        return done("Supervisor assigned.");
      case "end_supervision":
        await c.endSupervision(uid, str(form, "assignmentId"));
        return done("Supervision ended. They keep their current project role until you change it.");
      case "accept_invitation": {
        const res = str(form, "token") ? await c.accept(uid, str(form, "token")) : await c.acceptById(uid, str(form, "invitationId"));
        target = res.projectId ? `/app/projects/${res.projectId}` : "/app";
        return;
      }
      case "decline_invitation":
        await c.decline(uid, str(form, "invitationId"));
        return done("Invitation declined.", "/app");
      case "submit": {
        const row = await c.submit(uid, str(form, "documentId"), { reviewerUserId: str(form, "reviewerUserId") || null, message: str(form, "message"), dueDate: str(form, "dueDate") || null, attachPdf: form.get("attachPdf") === "on" });
        target = `/app/projects/${row.projectId}/reviews/${row.id}`;
        return;
      }
      case "withdraw":
        await c.withdraw(uid, str(form, "requestId"));
        return done("Submission withdrawn.");
      case "summary":
        await c.saveSummary(uid, str(form, "requestId"), str(form, "summary"));
        return done("Feedback saved.");
      case "comment":
        await c.addComment(uid, str(form, "requestId"), { sectionKey: str(form, "sectionKey") || null, quote: str(form, "quote"), body: str(form, "body"), severity: str(form, "severity"), createTask: form.get("createTask") === "on" });
        return done("Comment added.");
      case "decide": {
        const decision = str(form, "decision") === "approved" ? "approved" : "changes_requested";
        await c.decide(uid, str(form, "requestId"), decision, str(form, "note"));
        return done(decision === "approved" ? "Approved. The researcher has been notified." : "Changes requested. The researcher has been notified.");
      }
      case "add_task":
        await c.createRevision(uid, str(form, "requestId"), { title: str(form, "title"), description: str(form, "description"), sectionKey: str(form, "sectionKey") || null, dueDate: str(form, "dueDate") || null });
        return done("Revision task added.");
      case "respond":
        await c.respond(uid, str(form, "taskId"), str(form, "status") === "declined" ? "declined" : "addressed", str(form, "response"));
        return done("Response saved. Your supervisor can now verify it.");
      case "verify":
        await c.verify(uid, str(form, "taskId"), str(form, "accept") === "true", str(form, "note"));
        return done(str(form, "accept") === "true" ? "Verified." : "Reopened.");
      default:
        throw new AppError("VALIDATION", "Unknown action.");
    }
  });
  if (target) redirect(target);
  return r;
}
