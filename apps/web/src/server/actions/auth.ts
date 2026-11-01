"use server";

import { AppError } from "@researchmate/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type FormState, handle, str } from "../form";
import { authService } from "../services";
import { CHALLENGE_COOKIE, clearSessionCookie, getSession, requestContext, setChallengeCookie, setSessionCookie } from "../session";

function safeNext(next: string): string {
  // Only allow same-site relative paths to prevent open redirects.
  return next.startsWith("/app") && !next.startsWith("//") ? next : "/app";
}

export async function registerAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    if (str(form, "password") !== str(form, "confirmPassword")) throw new AppError("VALIDATION", "The passwords don't match.");
    if (form.get("terms") !== "on") throw new AppError("VALIDATION", "Accept the terms and academic-integrity notice to continue.");
    const res = await authService().register({
      email: str(form, "email"),
      password: str(form, "password"),
      displayName: str(form, "displayName"),
      ctx: await requestContext(),
    });
    if (res.status === "signed_in") {
      await setSessionCookie(res.token, res.expiresAt);
      redirect("/app");
    }
    redirect(`/register/check-email?email=${encodeURIComponent(str(form, "email").trim().toLowerCase())}`);
  });
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const next = safeNext(str(form, "next"));
    const res = await authService().login({ email: str(form, "email"), password: str(form, "password"), ctx: await requestContext() });
    if (res.status === "two_factor_required") {
      await setChallengeCookie(res.challengeToken);
      redirect(`/login/two-factor?next=${encodeURIComponent(next)}`);
    }
    await setSessionCookie(res.token, res.expiresAt);
    redirect(next);
  });
}

export async function twoFactorLoginAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const jar = await cookies();
    const challenge = jar.get(CHALLENGE_COOKIE())?.value;
    if (!challenge) throw new AppError("UNAUTHENTICATED", "Your sign-in attempt expired. Sign in again.");
    const res = await authService().completeTwoFactorLogin({ challengeToken: challenge, code: str(form, "code"), ctx: await requestContext() });
    jar.delete(CHALLENGE_COOKIE());
    await setSessionCookie(res.token, res.expiresAt);
    redirect(res.usedRecoveryCode ? "/app/settings/security?recovery=used" : safeNext(str(form, "next")));
  });
}

export async function logoutAction(): Promise<void> {
  const s = await getSession();
  if (s) await authService().logout(s.sessionId, s.user.id, await requestContext());
  await clearSessionCookie();
  redirect("/login");
}

export async function verifyEmailAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    await authService().verifyEmail(str(form, "token"), await requestContext());
    redirect("/login?verified=1");
  });
}

export async function resendVerificationAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    await authService().resendVerification(str(form, "email"), await requestContext());
    return { success: "If that address has an unverified account, a new link is on its way." };
  });
}

export async function forgotPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    await authService().requestPasswordReset(str(form, "email"), await requestContext());
    return { success: "If an account uses that address, we've emailed a reset link. It expires in one hour." };
  });
}

export async function resetPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    if (str(form, "password") !== str(form, "confirmPassword")) throw new AppError("VALIDATION", "The passwords don't match.");
    await authService().resetPassword(str(form, "token"), str(form, "password"), await requestContext());
    await clearSessionCookie();
    redirect("/login?reset=1");
  });
}
