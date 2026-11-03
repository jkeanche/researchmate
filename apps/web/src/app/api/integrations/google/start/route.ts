import { encryptSecret, env, isAppError } from "@researchmate/shared";
import { OAUTH_AAD as AAD, OAUTH_COOKIE } from "@/server/oauth";
import { NextResponse, type NextRequest } from "next/server";
import { sessionFromRequest } from "@/server/http";
import { driveConfigured, driveService } from "@/server/services";
import { ORG_COOKIE } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts Google OAuth. State and PKCE verifier live in an encrypted, httpOnly, 10-minute cookie. */
export async function GET(req: NextRequest) {
  const back = new URL("/app/settings/integrations", env().APP_URL);
  try {
    const session = await sessionFromRequest(req);
    if (!driveConfigured()) throw new Error("not configured");
    const orgId = req.cookies.get(ORG_COOKIE)?.value ?? "";
    const { url, state, verifier } = await (await driveService()).startAuth(session.user.id, orgId);
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, encryptSecret(JSON.stringify({ state, verifier, orgId, userId: session.user.id, at: Date.now() }), AAD), {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/google",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    back.searchParams.set("error", isAppError(err) ? err.message : "Google Drive isn't available right now.");
    return NextResponse.redirect(back);
  }
}

