import { Readable } from "node:stream";
import { AppError } from "@researchmate/shared";
import { type NextRequest } from "next/server";
import { errorResponse, sessionFromRequest } from "@/server/http";
import { fileService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
function contentDisposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Only these types may be shown inline; everything else downloads. Text is
// served as attachment to avoid any chance of rendering uploaded HTML/script.
const INLINE_SAFE = new Set(["application/pdf", "image/png", "image/jpeg"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new AppError("NOT_FOUND", "File not found.");
    const session = await sessionFromRequest(req);
    const v = req.nextUrl.searchParams.get("version");
    const version = v ? Number(v) : undefined;
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new AppError("VALIDATION", "Invalid version.");

    const { file, version: ver, stream } = await (await fileService()).openForDownload(session.user.id, fileId, version);
    const inline = req.nextUrl.searchParams.get("inline") === "1" && INLINE_SAFE.has(ver.mimeType);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: {
        "Content-Type": ver.mimeType,
        "Content-Length": String(ver.sizeBytes),
        "Content-Disposition": contentDisposition(file.originalName, inline),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${ver.checksumSha256}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
