import { type ValidSession, validateSession } from "@researchmate/auth";
import { env } from "@researchmate/shared";
import { getOrgAccess, listUserOrganizations, type OrgAccess, type UserOrganization } from "@researchmate/tenancy";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "./services";

const secure = () => env().NODE_ENV === "production";
/** __Host- prefix pins the cookie to this exact origin over HTTPS. */
export const SESSION_COOKIE = () => (secure() ? "__Host-rm_session" : "rm_session");
export const CHALLENGE_COOKIE = () => (secure() ? "__Host-rm_2fa" : "rm_2fa");
export const ORG_COOKIE = "rm_org";

export async function requestContext() {
  const h = await headers();
  return {
    ipAddress: h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE(), token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE());
}

export async function setChallengeCookie(token: string) {
  (await cookies()).set(CHALLENGE_COOKIE(), token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 300 });
}

/** Current session for this request (memoised per render). */
export const getSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE())?.value;
  if (!token) return null;
  return validateSession(db(), token, env().SESSION_TTL_DAYS);
});

export async function requireSession(): Promise<ValidSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export interface Workspace {
  session: ValidSession;
  organizations: UserOrganization[];
  org: OrgAccess;
}

/**
 * Session plus the active organization. The org cookie is only a preference;
 * membership is re-checked on every request.
 */
export const requireWorkspace = cache(async (): Promise<Workspace> => {
  const session = await requireSession();
  const organizations = await listUserOrganizations(db(), session.user.id);
  if (organizations.length === 0) redirect("/app/organizations/new");
  const preferred = (await cookies()).get(ORG_COOKIE)?.value;
  const chosen = organizations.find((o) => o.id === preferred) ?? organizations[0]!;
  const org = await getOrgAccess(db(), session.user.id, chosen.id);
  return { session, organizations, org };
});
