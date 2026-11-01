import { Readable } from "node:stream";
import { AuthService, CapturingMailer, MemoryRateLimiter, currentStep, totpAt } from "@researchmate/auth";
import { createDatabase, type Database, organizations, plans, subscriptions, users } from "@researchmate/database";
import { LocalStorageDriver, FileService } from "@researchmate/storage";
import { ProjectService } from "@researchmate/research";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

let shared: { db: Database; close: () => Promise<void> } | undefined;

export function testDb(): Database {
  if (!shared) {
    const { db, sql } = createDatabase(process.env.DATABASE_URL!, { max: 10 });
    shared = { db, close: () => sql.end({ timeout: 5 }) };
  }
  return shared.db;
}

export async function closeTestDb() {
  await shared?.close();
  shared = undefined;
}

export function makeAuth(opts: { requireEmailVerification?: boolean } = {}) {
  const mailer = new CapturingMailer();
  const limiter = new MemoryRateLimiter();
  const auth = new AuthService({
    db: testDb(),
    mailer,
    limiter,
    config: { appUrl: "http://localhost:3000", requireEmailVerification: opts.requireEmailVerification ?? false, sessionTtlDays: 30 },
  });
  return { auth, mailer, limiter };
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export const PASSWORD = "correct horse battery staple";

/** Registers a verified user and returns ids for the user and their personal organization. */
export async function createUser(name = "Test Researcher") {
  const { auth } = makeAuth();
  const email = uniqueEmail();
  const res = await auth.register({ email, password: PASSWORD, displayName: name });
  if (res.status !== "signed_in") throw new Error("expected signed_in");
  const db = testDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.ownerUserId, res.userId));
  return { userId: res.userId, email, orgId: org!.id, token: res.token };
}

export async function setPlan(orgId: string, planKey: string) {
  const db = testDb();
  const [plan] = await db.select().from(plans).where(eq(plans.key, planKey));
  await db.update(subscriptions).set({ status: "canceled" }).where(and(eq(subscriptions.organizationId, orgId), eq(subscriptions.status, "active")));
  await db.insert(subscriptions).values({ organizationId: orgId, planId: plan!.id, status: "active" });
}

export function fileServices(maxUploadBytes = 200 * 1024 * 1024) {
  const driver = new LocalStorageDriver(process.env.LOCAL_STORAGE_ROOT!);
  return { driver, files: new FileService({ db: testDb(), driver, maxUploadBytes }), projects: new ProjectService(testDb()) };
}

export function pdfBuffer(size: number): Buffer {
  const header = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const body = Buffer.alloc(Math.max(0, size - header.length), 0x20);
  return Buffer.concat([header, body]).subarray(0, size);
}

export function textBuffer(size: number): Buffer {
  return Buffer.alloc(size, "a");
}

export function streamOf(buf: Buffer) {
  return Readable.from([buf]);
}

/** A TOTP code for the next unused step (avoids replay rejection in fast tests). */
export function codeFor(secret: string, offset = 0) {
  return totpAt(secret, currentStep() + offset);
}

export { users };
