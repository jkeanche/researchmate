import { env, isAppError, logger, safeEqual } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { sessionFromRequest } from "@/server/http";
import { driveService } from "@/server/services";
import { OAUTH_COOKIE, readOAuthCookie } from "@/server/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google redirects here. The state must match the cookie set for this user (CSRF protection). */
export async function GET(req: NextRequest) {
  const back = new URL("/app/settings/integrations", env().APP_URL);
  const done = (key: "connected" | "error", value: string) => {
    back.searchParams.set(key, value);
    const res = NextResponse.redirect(back);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/integrations/google" });
    return res;
  };
  try {
    const session = await sessionFromRequest(req);
    const saved = readOAuthCookie(req.cookies.get(OAUTH_COOKIE)?.value);
    const q = req.nextUrl.searchParams;
    if (q.get("error")) return done("error", q.get("error") === "access_denied" ? "You cancelled the Google sign-in." : "Google sign-in failed.");
    const state = q.get("state") ?? "";
    if (!saved || saved.userId !== session.user.id || !state || !safeEqual(state, saved.state)) return done("error", "The sign-in link expired or didn't match. Please try again.");
    const code = q.get("code");
    if (!code) return done("error", "Google didn't return an authorisation code.");
    await (await driveService()).completeAuth(session.user.id, saved.orgId, code, saved.verifier);
    return done("connected", "1");
  } catch (err) {
    if (!isAppError(err)) logger.error("google.callback_failed", { error: err instanceof Error ? err.stack : String(err) });
    return done("error", isAppError(err) ? err.message : "Connecting Google Drive failed.");
  }
}
