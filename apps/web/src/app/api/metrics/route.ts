import { env, safeEqual } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { renderMetrics } from "@/server/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/metrics — Prometheus scrape target. Requires `Authorization: Bearer $METRICS_TOKEN`; 404 when unset. */
export async function GET(req: NextRequest) {
  const token = env().METRICS_TOKEN;
  if (!token) return new NextResponse("Not found", { status: 404 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, token)) return new NextResponse("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  return new NextResponse(await renderMetrics(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
}
