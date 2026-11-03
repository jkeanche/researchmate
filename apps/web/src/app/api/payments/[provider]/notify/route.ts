import { isAppError, logger } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { paymentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook / IPN endpoint for a payment provider. The provider adapter
 * authenticates the notification (signature where the provider signs), and
 * the payment's status is always re-fetched from the provider before
 * anything is granted. Duplicate deliveries are recognised and ignored.
 */
async function handle(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const body = req.method === "GET" ? "" : await req.text();
  if (body.length > 256_000) return new NextResponse("Too large", { status: 413 });
  try {
    const r = await paymentService().handleNotification(provider, { method: req.method, url: new URL(req.url), headers: req.headers, body });
    return new NextResponse(r.response.body, { status: r.response.status, headers: { "Content-Type": r.response.contentType, "Cache-Control": "no-store" } });
  } catch (err) {
    if (isAppError(err) && (err.code === "FORBIDDEN" || err.code === "VALIDATION" || err.code === "NOT_FOUND")) {
      logger.warn("billing.notification_rejected", { provider, error: err.message });
      return new NextResponse("Rejected", { status: err.code === "NOT_FOUND" ? 404 : 400 });
    }
    logger.error("billing.notification_failed", { provider, error: String(err), cause: String((err as { cause?: unknown }).cause ?? "") });
    // 5xx so the provider retries later.
    return new NextResponse("Error", { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
