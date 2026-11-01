import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { AppError } from "@researchmate/shared";
import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, errorResponse, sessionFromRequest } from "@/server/http";
import { fileService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PUT /api/files?organizationId=…&projectId=…&name=…
 * Body: the raw file bytes. Content-Length is required so quota can be
 * reserved before any bytes are accepted; the body is streamed to storage.
 */
export async function PUT(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await sessionFromRequest(req);
    const q = req.nextUrl.searchParams;
    const organizationId = q.get("organizationId") ?? "";
    const projectId = q.get("projectId") || null;
    const name = q.get("name") ?? "";
    if (!UUID.test(organizationId) || (projectId && !UUID.test(projectId))) throw new AppError("VALIDATION", "Invalid upload target.");
    const length = Number(req.headers.get("content-length"));
    if (!req.headers.get("content-length") || !Number.isSafeInteger(length)) throw new AppError("VALIDATION", "The upload must include its size.");
    if (!req.body) throw new AppError("VALIDATION", "The file is empty.");

    const svc = await fileService();
    const file = await svc.upload({
      actorUserId: session.user.id,
      organizationId,
      projectId,
      filename: name,
      declaredSize: length,
      body: Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>),
    });
    return NextResponse.json({ file: { id: file.id, originalName: file.originalName, mimeType: file.mimeType } }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
