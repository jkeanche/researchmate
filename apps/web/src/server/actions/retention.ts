"use server";

import { restoreOrganization, scheduleOrganizationDeletion } from "@researchmate/tenancy";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { authService, db } from "../services";
import { clearSessionCookie, ORG_COOKIE, requestContext, requireSession, requireWorkspace } from "../session";

/** Owner only (checked in scheduleOrganizationDeletion), after reauthentication and typing the name. */
export async function deleteOrganizationAction(_: FormState, form: FormData): Promise<FormState> {
  let done = false;
  const r = await handle(async () => {
    const { session, org } = await requireWorkspace();
    await authService().reauthenticate({ userId: session.user.id, sessionId: session.sessionId, password: str(form, "password"), code: str(form, "code"), ctx: await requestContext() });
    await scheduleOrganizationDeletion(db(), session.user.id, org.organizationId, str(form, "confirmName"));
    (await cookies()).delete(ORG_COOKIE);
    done = true;
  });
  if (done) redirect("/workspace");
  return r;
}

export async function restoreOrganizationAction(_: FormState, form: FormData): Promise<FormState> {
  let restored = "";
  const r = await handle(async () => {
    const s = await requireSession();
    const org = await restoreOrganization(db(), s.user.id, str(form, "organizationId"));
    (await cookies()).set(ORG_COOKIE, org.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    revalidatePath("/app", "layout");
    restored = org.id;
  });
  if (restored) redirect("/app/settings/organization");
  return r;
}

export async function deleteAccountAction(_: FormState, form: FormData): Promise<FormState> {
  let done = false;
  const r = await handle(async () => {
    const s = await requireSession();
    if (str(form, "confirm") !== "DELETE") return { error: "Type DELETE to confirm." };
    await authService().deleteAccount({ userId: s.user.id, sessionId: s.sessionId, password: str(form, "password"), code: str(form, "code"), ctx: await requestContext() });
    await clearSessionCookie();
    done = true;
  });
  if (done) redirect("/login?account_deleted=1");
  return r;
}
