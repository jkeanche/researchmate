import { type DbOrTx, sessions, users } from "@researchmate/database";
import { hmacHex, randomToken } from "@researchmate/shared";
import { and, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";

/**
 * Database-backed sessions. The cookie holds a 256-bit random token; the
 * database stores only HMAC(APP_SECRET, token), so a database leak cannot be
 * turned into live sessions.
 */

const DAY = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  isPlatformAdmin: boolean;
}

export interface ValidSession {
  sessionId: string;
  user: SessionUser;
  twoFactorVerified: boolean;
  reauthenticatedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export function sessionIdFromToken(token: string): string {
  return hmacHex(`session:${token}`);
}

export async function createSession(
  db: DbOrTx,
  userId: string,
  opts: SessionContext & { ttlDays: number; twoFactorVerified: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + opts.ttlDays * DAY);
  await db.insert(sessions).values({
    id: sessionIdFromToken(token),
    userId,
    expiresAt,
    ipAddress: normaliseIp(opts.ipAddress),
    userAgent: opts.userAgent?.slice(0, 500) ?? null,
    twoFactorVerified: opts.twoFactorVerified,
    reauthenticatedAt: new Date(),
  });
  return { token, expiresAt };
}

/**
 * Validates a session token. Sliding expiry: when less than half the lifetime
 * remains the expiry is extended. Returns null for unknown, expired, revoked
 * sessions and disabled users.
 */
export async function validateSession(db: DbOrTx, token: string, ttlDays: number): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const id = sessionIdFromToken(token);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      twoFactorVerified: sessions.twoFactorVerified,
      reauthenticatedAt: sessions.reauthenticatedAt,
      userId: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isPlatformAdmin: users.isPlatformAdmin,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)));

  if (!row || row.status !== "active") return null;

  const now = Date.now();
  let expiresAt = row.expiresAt;
  const needsExtend = expiresAt.getTime() - now < (ttlDays * DAY) / 2;
  const needsTouch = now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  if (needsExtend || needsTouch) {
    if (needsExtend) expiresAt = new Date(now + ttlDays * DAY);
    await db.update(sessions).set({ lastSeenAt: new Date(now), expiresAt }).where(eq(sessions.id, id));
  }

  return {
    sessionId: row.sessionId,
    user: { id: row.userId, email: row.email, emailVerifiedAt: row.emailVerifiedAt, isPlatformAdmin: row.isPlatformAdmin },
    twoFactorVerified: row.twoFactorVerified,
    reauthenticatedAt: row.reauthenticatedAt,
    createdAt: row.createdAt,
    expiresAt,
  };
}

export async function revokeSession(db: DbOrTx, sessionId: string, userId?: string): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), userId ? eq(sessions.userId, userId) : undefined))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeAllSessions(db: DbOrTx, userId: string, exceptSessionId?: string): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listActiveSessions(db: DbOrTx, userId: string) {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      twoFactorVerified: sessions.twoFactorVerified,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(sql`${sessions.lastSeenAt} desc`);
}

export async function markReauthenticated(db: DbOrTx, sessionId: string): Promise<void> {
  await db.update(sessions).set({ reauthenticatedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** Deletes sessions that expired or were revoked more than 30 days ago. */
export async function purgeStaleSessions(db: DbOrTx): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * DAY);
  const rows = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });
  return rows.length;
}

export function normaliseIp(ip?: string | null): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0]!.trim();
  // Accept IPv4 / IPv6 shapes only; anything else is discarded rather than stored.
  if (/^[0-9.]{7,15}$/.test(first) || /^[0-9a-fA-F:.]{2,45}$/.test(first)) return first;
  return null;
}
