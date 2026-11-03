import { getRedis } from "@researchmate/auth";
import { getStorageDriver } from "@researchmate/storage";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { workerHeartbeatAge } from "@/server/metrics";
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
  // The worker is reported but doesn't fail the web container's health check (it restarts independently).
  const worker = (await workerHeartbeatAge()) === null ? "missing" : "ok";
  return NextResponse.json({ status: ok ? (worker === "ok" ? "ok" : "degraded") : "degraded", checks: { database, redis, storage, worker } }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
