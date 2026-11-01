import { getRedis } from "@researchmate/auth";
import { getStorageDriver } from "@researchmate/storage";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function check(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<"ok" | "error"> {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    return "ok";
  } catch {
    return "error";
  }
}

/** Liveness + dependency health for Docker, Nginx and monitoring. Reveals no configuration. */
export async function GET() {
  const [database, redis, storage] = await Promise.all([
    check(() => db().execute(sql`select 1`)),
    check(() => getRedis().ping()),
    check(async () => (await getStorageDriver()).healthCheck()),
  ]);
  const ok = database === "ok" && redis === "ok" && storage === "ok";
  return NextResponse.json({ status: ok ? "ok" : "degraded", checks: { database, redis, storage } }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
