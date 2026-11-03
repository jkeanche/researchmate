import { logger } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@researchmate/shared";
import { paymentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The customer's browser comes back here. The redirect proves nothing: we ask the provider, then show the result. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  let status = "pending";
  try {
    const p = await paymentService().handleReturn(provider, req.nextUrl.searchParams);
    status = p?.status ?? "unknown";
  } catch (err) {
    logger.warn("billing.return_check_failed", { provider, error: String(err), cause: String((err as { cause?: unknown }).cause ?? "") });
  }
  return NextResponse.redirect(new URL(`/app/settings/billing?payment=${encodeURIComponent(status)}`, env().APP_URL), 303);
}
