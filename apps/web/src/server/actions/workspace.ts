"use server";

import { AppError } from "@researchmate/shared";
import { addMemberByEmail, changeMemberRole, createOrganization, getOrgAccess, removeMember } from "@researchmate/tenancy";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { db, fileService, projectService } from "../services";
import { ORG_COOKIE, requireSession, requireWorkspace } from "../session";

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export async function switchOrganizationAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const id = str(form, "organizationId");
  await getOrgAccess(db(), s.user.id, id); // must be a member
  (await cookies()).set(ORG_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/app");
}

export async function createOrganizationAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const org = await db().transaction((tx) => createOrganization(tx, { ownerUserId: s.user.id, name: str(form, "name"), kind: "team" }));
    (await cookies()).set(ORG_COOKIE, org.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    redirect("/app/settings/organization");
  });
}

export async function addMemberAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    await addMemberByEmail(db(), session.user.id, org.organizationId, str(form, "email"), str(form, "roleKey"));
    revalidatePath("/app/settings/organization");
    return { success: "Member added." };
  });
}

export async function changeMemberRoleAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    await changeMemberRole(db(), session.user.id, org.organizationId, str(form, "userId"), str(form, "roleKey"));
    revalidatePath("/app/settings/organization");
    return { success: "Role updated." };
  });
}

export async function removeMemberAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    await removeMember(db(), session.user.id, org.organizationId, str(form, "userId"));
    revalidatePath("/app/settings/organization");
    return { success: "Member removed." };
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function projectFields(form: FormData) {
  const pick = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return {
    title: pick("title"),
    description: pick("description"),
    researchType: pick("researchType"),
    academicLevel: pick("academicLevel"),
    discipline: pick("discipline"),
    institution: pick("institution"),
    department: pick("department"),
    methodology: pick("methodology"),
    citationStyle: pick("citationStyle"),
    targetWordCount: pick("targetWordCount"),
    targetPageCount: pick("targetPageCount"),
    startDate: pick("startDate"),
    expectedCompletionDate: pick("expectedCompletionDate"),
  };
}

export async function createProjectAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const { session, org } = await requireWorkspace();
    // Validation happens in the service; the cast only narrows FormData strings.
    const project = await projectService().create(session.user.id, org.organizationId, projectFields(form) as never);
    redirect(`/app/projects/${project.id}`);
  });
}

export async function updateProjectAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const session = await requireSession();
    const id = str(form, "projectId");
    const fields = Object.fromEntries(Object.entries(projectFields(form)).filter(([, v]) => v !== undefined));
    const status = str(form, "status");
    const progress = str(form, "progressPercent");
    await projectService().update(session.user.id, id, { ...fields, ...(status ? { status } : {}), ...(progress ? { progressPercent: progress } : {}) });
    revalidatePath(`/app/projects/${id}`);
    return { success: "Project saved." };
  });
}

export async function archiveProjectAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const id = str(form, "projectId");
    if (str(form, "intent") === "restore") await projectService().restore(s.user.id, id);
    else await projectService().archive(s.user.id, id);
    revalidatePath(`/app/projects/${id}`);
    revalidatePath("/app/projects");
    return {};
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function deleteFileAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const id = str(form, "fileId");
    if (!id) throw new AppError("VALIDATION", "Missing file.");
    await (await fileService()).delete(s.user.id, id);
    revalidatePath("/app/files");
    revalidatePath("/app");
    const projectId = str(form, "projectId");
    if (projectId) revalidatePath(`/app/projects/${projectId}`);
    return { success: "File deleted." };
  });
}
