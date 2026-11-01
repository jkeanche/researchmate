import { validateSession } from "@researchmate/auth";
import { AppError, env, isAppError, logger } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "./services";
import { SESSION_COOKIE } from "./session";

/**
 * CSRF defence for route handlers that change state: the Origin header must
 * match APP_URL. (Server actions get Next's built-in origin check.)
 */
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  const expected = new URL(env().APP_URL).origin;
  if (!origin || origin !== expected) throw new AppError("FORBIDDEN", "Cross-origin request refused.");
}

export async function sessionFromRequest(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE())?.value;
  const session = token ? await validateSession(db(), token, env().SESSION_TTL_DAYS) : null;
  if (!session) throw new AppError("UNAUTHENTICATED", "Sign in to continue.");
  return session;
}

export function errorResponse(err: unknown): NextResponse {
  if (isAppError(err)) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  logger.error("route.failed", { error: err instanceof Error ? err.stack : String(err) });
  return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
}
