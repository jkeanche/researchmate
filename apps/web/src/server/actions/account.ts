"use server";

import { userProfiles } from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { authService, db } from "../services";
import { requestContext, requireSession } from "../session";

export async function beginTwoFactorAction(_: FormState): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const enrollment = await authService().beginTwoFactorEnrollment(s.user.id);
    return { data: { secret: enrollment.secret, qr: enrollment.qrCodeDataUrl } };
  });
}

export async function confirmTwoFactorAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const { recoveryCodes } = await authService().confirmTwoFactorEnrollment({
      userId: s.user.id,
      sessionId: s.sessionId,
      code: str(form, "code"),
      ctx: await requestContext(),
    });
    return { success: "Two-factor authentication is on.", data: { recoveryCodes } };
  });
}

export async function disableTwoFactorAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    await authService().disableTwoFactor({ userId: s.user.id, sessionId: s.sessionId, password: str(form, "password"), code: str(form, "code"), ctx: await requestContext() });
    revalidatePath("/app/settings/security");
    return { success: "Two-factor authentication is off. Other sessions were signed out." };
  });
}

export async function regenerateRecoveryCodesAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const codes = await authService().regenerateRecoveryCodes({ userId: s.user.id, sessionId: s.sessionId, password: str(form, "password"), code: str(form, "code"), ctx: await requestContext() });
    return { success: "New recovery codes created. Your old codes no longer work.", data: { recoveryCodes: codes } };
  });
}

export async function changePasswordAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    if (str(form, "newPassword") !== str(form, "confirmPassword")) throw new AppError("VALIDATION", "The new passwords don't match.");
    await authService().changePassword({
      userId: s.user.id,
      sessionId: s.sessionId,
      currentPassword: str(form, "currentPassword"),
      newPassword: str(form, "newPassword"),
      ctx: await requestContext(),
    });
    revalidatePath("/app/settings/security");
    return { success: "Password changed. Your other sessions were signed out." };
  });
}

export async function revokeSessionAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const id = str(form, "sessionId");
    if (id === s.sessionId) throw new AppError("VALIDATION", "Use sign out to end this session.");
    await authService().revokeSessionForUser(s.user.id, id, await requestContext());
    revalidatePath("/app/settings/security");
    return { success: "Session signed out." };
  });
}

export async function revokeOtherSessionsAction(_: FormState): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const n = await authService().revokeOtherSessions(s.user.id, s.sessionId, await requestContext());
    revalidatePath("/app/settings/security");
    return { success: n ? `Signed out ${n} other session${n === 1 ? "" : "s"}.` : "No other sessions were active." };
  });
}

export async function updateProfileAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const clean = (k: string, max: number) => {
      const v = str(form, k).trim().replace(/\s+/g, " ");
      if (v.length > max) throw new AppError("VALIDATION", `${k} is too long.`);
      return v || null;
    };
    const displayName = clean("displayName", 100);
    if (!displayName) throw new AppError("VALIDATION", "Enter your name.");
    await db()
      .update(userProfiles)
      .set({
        displayName,
        institution: clean("institution", 200),
        department: clean("department", 200),
        discipline: clean("discipline", 150),
        academicLevel: clean("academicLevel", 100),
        updatedAt: new Date(),
      })
      .where(eq(userProfiles.userId, s.user.id));
    revalidatePath("/app", "layout");
    return { success: "Profile saved." };
  });
}
