import {
  authTokens,
  connectedAccounts,
  type Database,
  type DbOrTx,
  notificationPreferences,
  notifications,
  organizationMembers,
  organizations,
  projectMembers,
  securityEvents,
  sessions,
  userApiCredentials,
  twoFactorRecoveryCodes,
  twoFactorSettings,
  userProfiles,
  users,
} from "@researchmate/database";
import { AppError, decryptSecret, encryptSecret, hmacHex, logger, randomToken } from "@researchmate/shared";
import { createOrganization, notify, scheduleOrganizationDeletion } from "@researchmate/tenancy";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { emailTemplates, type Mailer } from "./mail";
import { hashPassword, validatePassword, verifyDummyPassword, verifyPassword } from "./password";
import { enforceRateLimit, type RateLimiter } from "./rate-limit";
import { createSession, markReauthenticated, normaliseIp, revokeAllSessions, revokeSession, type SessionContext } from "./sessions";
import { base32Decode, generateTotpSecret, otpauthUrl, verifyTotp } from "./totp";

export interface AuthConfig {
  appUrl: string;
  requireEmailVerification: boolean;
  sessionTtlDays: number;
  issuer?: string;
}

export interface AuthDeps {
  db: Database;
  mailer: Mailer;
  limiter: RateLimiter;
  config: AuthConfig;
}

export type LoginResult =
  | { status: "signed_in"; token: string; expiresAt: Date; userId: string }
  | { status: "two_factor_required"; challengeToken: string };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TOKEN_TTL = {
  email_verification: 24 * HOUR,
  password_reset: HOUR,
  two_factor_challenge: 5 * MINUTE,
} as const;
type TokenPurpose = keyof typeof TOKEN_TTL;

const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const REAUTH_WINDOW_MS = 10 * MINUTE;

export function normaliseEmail(email: string): string {
  const e = (email ?? "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AppError("VALIDATION", "Enter a valid email address.");
  return e;
}

function tokenHash(purpose: TokenPurpose, token: string) {
  return hmacHex(`${purpose}:${token}`);
}

function recoveryCodeHash(userId: string, code: string) {
  return hmacHex(`recovery:${userId}:${code.replace(/[\s-]/g, "").toUpperCase()}`);
}

function generateRecoveryCode(): string {
  // 10 base32 characters (50 bits), formatted XXXXX-XXXXX.
  const raw = randomToken(16).replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/[01OI8]/g, "").slice(0, 10).padEnd(10, "Z");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  private get db() {
    return this.deps.db;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async event(db: DbOrTx, type: string, userId: string | null, ctx?: SessionContext, metadata: Record<string, unknown> = {}) {
    if (userId) await this.securityNotice(db, type, userId, ctx);
    await db.insert(securityEvents).values({
      userId,
      type,
      ipAddress: normaliseIp(ctx?.ipAddress),
      userAgent: ctx?.userAgent?.slice(0, 500) ?? null,
      metadata,
    });
  }


  /**
   * Security notices (§30): account changes, and sign-ins from a device and
   * network not seen in the last 90 days. Always emailed (locked kind).
   */
  private async securityNotice(db: DbOrTx, type: string, userId: string, ctx?: SessionContext) {
    const where = ctx?.ipAddress ? ` from ${normaliseIp(ctx.ipAddress) ?? "an unknown address"}` : "";
    const notices: Record<string, [string, string]> = {
      "password.changed": ["Your password was changed", `Your ResearchMate password was changed${where}. If this wasn't you, reset your password now and contact your administrator.`],
      "password.reset_completed": ["Your password was reset", `Your ResearchMate password was reset${where}. All other sessions were signed out. If this wasn't you, reset it again and contact your administrator.`],
      "two_factor.enabled": ["Two-factor authentication turned on", `Two-factor authentication was turned on for your account${where}.`],
      "two_factor.disabled": ["Two-factor authentication turned off", `Two-factor authentication was turned off for your account${where}. If this wasn't you, change your password and turn it back on.`],
      "two_factor.recovery_codes_regenerated": ["New recovery codes generated", `New two-factor recovery codes were generated${where}; the old ones no longer work.`],
      "two_factor.recovery_code_used": ["A recovery code was used to sign in", `A two-factor recovery code was used to sign in${where}. Each code works once. If this wasn't you, change your password now.`],
      "session.revoked_all_others": ["Other sessions signed out", "All your other sessions were signed out."],
    };
    let n = notices[type];
    if (type === "login.succeeded" && ctx) {
      const ip = normaliseIp(ctx.ipAddress);
      const ua = ctx.userAgent?.slice(0, 500) ?? null;
      const [seen] = await db
        .select({ n: sql<number>`count(*)::int`, same: sql<number>`count(*) filter (where ${securityEvents.ipAddress} is not distinct from ${ip}::inet and ${securityEvents.userAgent} is not distinct from ${ua})::int` })
        .from(securityEvents)
        .where(and(eq(securityEvents.userId, userId), eq(securityEvents.type, "login.succeeded"), gt(securityEvents.createdAt, sql`now() - interval '90 days'`)));
      // The first sign-in after registration isn't news; a new device/network later is.
      if (seen && seen.n > 0 && seen.same === 0) n = ["New sign-in to your account", `Your account was signed in to${where} using ${ua ? ua.slice(0, 120) : "an unknown browser"}. If this wasn't you, change your password and sign out other sessions under Settings → Security.`];
    }
    if (!n) return;
    await notify(db, { userIds: [userId], kind: "security.alert", title: n[0], body: n[1], link: "/app/settings/security" });
  }

  private async issueToken(db: DbOrTx, userId: string, purpose: TokenPurpose): Promise<string> {
    const token = randomToken(32);
    await db.insert(authTokens).values({
      userId,
      purpose,
      tokenHash: tokenHash(purpose, token),
      expiresAt: new Date(Date.now() + TOKEN_TTL[purpose]),
    });
    return token;
  }

  /** Atomically consumes a single-use token. Returns the owning user id, or null. */
  private async consumeToken(db: DbOrTx, purpose: TokenPurpose, token: string): Promise<string | null> {
    if (!token || token.length > 128) return null;
    const [row] = await db
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash(purpose, token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: authTokens.userId });
    return row?.userId ?? null;
  }

  private async send(to: string, message: { subject: string; text: string; html?: string }) {
    try {
      await this.deps.mailer.send({ to, ...message });
    } catch (err) {
      // Email failures must not reveal account state or break the auth flow.
      logger.error("email.enqueue_failed", { subject: message.subject, error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Registration and email verification
  // -------------------------------------------------------------------------

  /**
   * Registers a user with a personal workspace on the default plan.
   * The response does not reveal whether the email was already registered.
   */
  async register(input: { email: string; password: string; displayName: string; ctx?: SessionContext }): Promise<
    { status: "verification_sent" } | { status: "signed_in"; token: string; expiresAt: Date; userId: string }
  > {
    const email = normaliseEmail(input.email);
    const displayName = (input.displayName ?? "").trim().replace(/\s+/g, " ");
    if (displayName.length < 1 || displayName.length > 100) throw new AppError("VALIDATION", "Enter your name (up to 100 characters).");
    validatePassword(input.password, email);
    await enforceRateLimit(this.deps.limiter, `register:ip:${input.ctx?.ipAddress ?? "unknown"}`, 10, 3600);

    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      await this.send(email, emailTemplates.accountExists(this.deps.config.appUrl));
      await this.event(this.db, "registration.duplicate", existing.id, input.ctx);
      if (!this.deps.config.requireEmailVerification) throw new AppError("CONFLICT", "An account with this email already exists. Sign in instead.");
      return { status: "verification_sent" };
    }

    const passwordHash = await hashPassword(input.password);
    const result = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash, emailVerifiedAt: this.deps.config.requireEmailVerification ? null : new Date() })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (!user) return null; // concurrent registration with the same email
      await tx.insert(userProfiles).values({ userId: user.id, displayName });
      await createOrganization(tx, { ownerUserId: user.id, name: `${displayName.split(" ")[0]}'s workspace`, kind: "personal" });
      await this.event(tx, "registration.created", user.id, input.ctx);
      const verifyToken = this.deps.config.requireEmailVerification ? await this.issueToken(tx, user.id, "email_verification") : null;
      return { userId: user.id, verifyToken };
    });

    if (!result) return { status: "verification_sent" };
    if (result.verifyToken) {
      await this.send(email, emailTemplates.verifyEmail(this.deps.config.appUrl, result.verifyToken));
      return { status: "verification_sent" };
    }
    const session = await createSession(this.db, result.userId, { ...input.ctx, ttlDays: this.deps.config.sessionTtlDays, twoFactorVerified: false });
    return { status: "signed_in", ...session, userId: result.userId };
  }

  async verifyEmail(token: string, ctx?: SessionContext): Promise<{ userId: string }> {
    return this.db.transaction(async (tx) => {
      const userId = await this.consumeToken(tx, "email_verification", token);
      if (!userId) throw new AppError("VALIDATION", "This verification link is invalid or has expired. Request a new one.");
      await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
      await this.event(tx, "email.verified", userId, ctx);
      return { userId };
    });
  }

  async resendVerification(emailInput: string, ctx?: SessionContext): Promise<void> {
    const email = normaliseEmail(emailInput);
    await enforceRateLimit(this.deps.limiter, `verify-resend:${email}`, 3, 3600);
    await enforceRateLimit(this.deps.limiter, `verify-resend:ip:${ctx?.ipAddress ?? "unknown"}`, 10, 3600);
    const [user] = await this.db.select({ id: users.id, verified: users.emailVerifiedAt }).from(users).where(eq(users.email, email));
    if (!user || user.verified) return;
    const token = await this.issueToken(this.db, user.id, "email_verification");
    await this.send(email, emailTemplates.verifyEmail(this.deps.config.appUrl, token));
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(input: { email: string; password: string; ctx?: SessionContext }): Promise<LoginResult> {
    let email: string;
    try {
      email = normaliseEmail(input.email);
    } catch {
      throw new AppError("UNAUTHENTICATED", "Incorrect email or password.");
    }
    await enforceRateLimit(this.deps.limiter, `login:ip:${input.ctx?.ipAddress ?? "unknown"}`, 30, 900);
    await enforceRateLimit(this.deps.limiter, `login:email:${email}`, 8, 900);

    const [user] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash, status: users.status, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, email));

    if (!user) {
      await verifyDummyPassword(input.password ?? "");
      await this.event(this.db, "login.failed", null, input.ctx, { reason: "unknown_email" });
      throw new AppError("UNAUTHENTICATED", "Incorrect email or password.");
    }
    if (!(await verifyPassword(user.passwordHash, input.password ?? ""))) {
      await this.event(this.db, "login.failed", user.id, input.ctx, { reason: "bad_password" });
      throw new AppError("UNAUTHENTICATED", "Incorrect email or password.");
    }
    if (user.status !== "active") {
      await this.event(this.db, "login.failed", user.id, input.ctx, { reason: "disabled" });
      throw new AppError("FORBIDDEN", "This account has been disabled. Contact support.");
    }
    if (this.deps.config.requireEmailVerification && !user.emailVerifiedAt) {
      throw new AppError("FORBIDDEN", "Verify your email address before signing in. Check your inbox or request a new link.", { reason: "email_unverified" });
    }
    await this.deps.limiter.reset(`login:email:${email}`);

    const [tfa] = await this.db.select({ enabledAt: twoFactorSettings.enabledAt }).from(twoFactorSettings).where(eq(twoFactorSettings.userId, user.id));
    if (tfa?.enabledAt) {
      const challengeToken = await this.issueToken(this.db, user.id, "two_factor_challenge");
      await this.event(this.db, "login.two_factor_challenge", user.id, input.ctx);
      return { status: "two_factor_required", challengeToken };
    }

    const session = await createSession(this.db, user.id, { ...input.ctx, ttlDays: this.deps.config.sessionTtlDays, twoFactorVerified: false });
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await this.event(this.db, "login.succeeded", user.id, input.ctx);
    return { status: "signed_in", ...session, userId: user.id };
  }

  /**
   * Second step of login. Accepts a TOTP code or a recovery code. A challenge
   * allows MAX_CHALLENGE_ATTEMPTS attempts and expires after five minutes.
   */
  async completeTwoFactorLogin(input: { challengeToken: string; code: string; ctx?: SessionContext }): Promise<LoginResult & { status: "signed_in"; usedRecoveryCode: boolean }> {
    const hash = tokenHash("two_factor_challenge", input.challengeToken ?? "");
    const [challenge] = await this.db
      .select({ id: authTokens.id, userId: authTokens.userId, attempts: authTokens.attempts })
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hash), eq(authTokens.purpose, "two_factor_challenge"), isNull(authTokens.consumedAt), gt(authTokens.expiresAt, sql`now()`)));
    if (!challenge) throw new AppError("UNAUTHENTICATED", "Your sign-in attempt expired. Sign in again.");
    await enforceRateLimit(this.deps.limiter, `2fa:user:${challenge.userId}`, 10, 900);

    const [bumped] = await this.db
      .update(authTokens)
      .set({ attempts: sql`${authTokens.attempts} + 1` })
      .where(and(eq(authTokens.id, challenge.id), sql`${authTokens.attempts} < ${MAX_CHALLENGE_ATTEMPTS}`))
      .returning({ attempts: authTokens.attempts });
    if (!bumped) {
      await this.db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, challenge.id));
      throw new AppError("UNAUTHENTICATED", "Too many incorrect codes. Sign in again.");
    }

    const code = (input.code ?? "").trim();
    const isTotp = /^\d{6}$/.test(code.replace(/\s/g, ""));
    const ok = isTotp ? await this.verifyTotpForUser(challenge.userId, code) : await this.useRecoveryCode(challenge.userId, code, input.ctx);
    if (!ok) {
      await this.event(this.db, "login.two_factor_failed", challenge.userId, input.ctx, { method: isTotp ? "totp" : "recovery_code" });
      throw new AppError("UNAUTHENTICATED", "That code is not valid.");
    }

    // Consume the challenge exactly once (protects against parallel replays).
    const [consumed] = await this.db
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(authTokens.id, challenge.id), isNull(authTokens.consumedAt)))
      .returning({ id: authTokens.id });
    if (!consumed) throw new AppError("UNAUTHENTICATED", "Your sign-in attempt expired. Sign in again.");

    const session = await createSession(this.db, challenge.userId, { ...input.ctx, ttlDays: this.deps.config.sessionTtlDays, twoFactorVerified: true });
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, challenge.userId));
    await this.event(this.db, "login.succeeded", challenge.userId, input.ctx, { twoFactor: isTotp ? "totp" : "recovery_code" });
    return { status: "signed_in", ...session, userId: challenge.userId, usedRecoveryCode: !isTotp };
  }

  async logout(sessionId: string, userId: string, ctx?: SessionContext): Promise<void> {
    await revokeSession(this.db, sessionId, userId);
    await this.event(this.db, "logout", userId, ctx);
  }

  async revokeSessionForUser(userId: string, sessionId: string, ctx?: SessionContext): Promise<void> {
    const ok = await revokeSession(this.db, sessionId, userId);
    if (!ok) throw new AppError("NOT_FOUND", "Session not found.");
    await this.event(this.db, "session.revoked", userId, ctx);
  }

  async revokeOtherSessions(userId: string, currentSessionId: string, ctx?: SessionContext): Promise<number> {
    const n = await revokeAllSessions(this.db, userId, currentSessionId);
    await this.event(this.db, "session.revoked_all_others", userId, ctx, { count: n });
    return n;
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  async requestPasswordReset(emailInput: string, ctx?: SessionContext): Promise<void> {
    let email: string;
    try {
      email = normaliseEmail(emailInput);
    } catch {
      return;
    }
    await enforceRateLimit(this.deps.limiter, `reset:ip:${ctx?.ipAddress ?? "unknown"}`, 10, 3600);
    const perEmail = await this.deps.limiter.hit(`reset:email:${email}`, 3, 3600);
    if (!perEmail.allowed) return; // silent: do not reveal account existence
    const [user] = await this.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.email, email));
    if (!user || user.status !== "active") return;
    const token = await this.issueToken(this.db, user.id, "password_reset");
    await this.event(this.db, "password.reset_requested", user.id, ctx);
    await this.send(email, emailTemplates.passwordReset(this.deps.config.appUrl, token));
  }

  /** Completes a reset: sets the password, verifies the email, revokes every session. */
  async resetPassword(token: string, newPassword: string, ctx?: SessionContext): Promise<void> {
    const hashP = hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      const userId = await this.consumeToken(tx, "password_reset", token);
      if (!userId) throw new AppError("VALIDATION", "This reset link is invalid or has expired. Request a new one.");
      const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
      validatePassword(newPassword, user?.email);
      await tx
        .update(users)
        .set({ passwordHash: await hashP, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`, updatedAt: new Date() })
        .where(eq(users.id, userId));
      // Invalidate every other outstanding reset token for this user.
      await tx
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, "password_reset"), isNull(authTokens.consumedAt)));
      await revokeAllSessions(tx, userId);
      await this.event(tx, "password.reset_completed", userId, ctx);
    });
  }

  async changePassword(input: { userId: string; sessionId: string; currentPassword: string; newPassword: string; ctx?: SessionContext }): Promise<void> {
    await enforceRateLimit(this.deps.limiter, `pwchange:${input.userId}`, 5, 900);
    const [user] = await this.db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, input.userId));
    if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword ?? ""))) {
      throw new AppError("VALIDATION", "Your current password is incorrect.");
    }
    validatePassword(input.newPassword, user.email);
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, input.userId));
      await revokeAllSessions(tx, input.userId, input.sessionId);
      await this.event(tx, "password.changed", input.userId, input.ctx);
    });
  }

  /**
   * Deletes the account (§29): after reauthentication, workspaces the user
   * owns alone are scheduled for deletion, memberships end, and credentials,
   * sessions, 2FA secrets, API keys, Drive tokens and notifications are
   * removed. The user row is pseudonymised rather than deleted, so audit
   * trails and append-only records (authorship of approvals, ledgers) stay
   * intact without identifying the person.
   */
  async deleteAccount(input: { userId: string; sessionId: string; password: string; code?: string; ctx?: SessionContext }): Promise<{ scheduledOrganizations: string[] }> {
    await this.reauthenticate(input);
    const owned = await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(and(eq(organizations.ownerUserId, input.userId), isNull(organizations.deletedAt)));
    for (const o of owned) {
      const [others] = await this.db.select({ n: sql<number>`count(*)::int` }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, o.id), ne(organizationMembers.userId, input.userId)));
      if (others!.n > 0) throw new AppError("VALIDATION", `“${o.name}” has other members. Remove them or ask an administrator to take it over before deleting your account.`);
    }
    const uid = input.userId;
    await this.db.transaction(async (tx) => {
      for (const o of owned) await scheduleOrganizationDeletion(tx, uid, o.id, o.name);
      await this.event(tx, "account.deleted", uid, input.ctx);
      await tx.delete(projectMembers).where(eq(projectMembers.userId, uid));
      await tx.delete(organizationMembers).where(and(eq(organizationMembers.userId, uid), sql`${organizationMembers.organizationId} not in (select id from organizations where owner_user_id = ${uid})`));
      await tx.delete(sessions).where(eq(sessions.userId, uid));
      await tx.delete(authTokens).where(eq(authTokens.userId, uid));
      await tx.delete(twoFactorSettings).where(eq(twoFactorSettings.userId, uid));
      await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, uid));
      await tx.delete(userApiCredentials).where(eq(userApiCredentials.userId, uid));
      await tx.delete(connectedAccounts).where(eq(connectedAccounts.userId, uid));
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, uid));
      await tx
        .update(users)
        .set({ email: `deleted-${uid}@deleted.invalid`, passwordHash: await hashPassword(randomToken()), emailVerifiedAt: null, isPlatformAdmin: false, status: "disabled", updatedAt: new Date() })
        .where(eq(users.id, uid));
      await tx.update(userProfiles).set({ displayName: "Deleted user", institution: null, department: null, discipline: null, academicLevel: null, updatedAt: new Date() }).where(eq(userProfiles.userId, uid));
    });
    return { scheduledOrganizations: owned.map((o) => o.name) };
  }

  /**
   * Confirms the user's identity for a sensitive action: password, plus a
   * TOTP or recovery code when 2FA is enabled.
   */
  async reauthenticate(input: { userId: string; sessionId: string; password: string; code?: string; ctx?: SessionContext }): Promise<void> {
    await enforceRateLimit(this.deps.limiter, `reauth:${input.userId}`, 8, 900);
    const [user] = await this.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, input.userId));
    if (!user || !(await verifyPassword(user.passwordHash, input.password ?? ""))) {
      await this.event(this.db, "reauth.failed", input.userId, input.ctx);
      throw new AppError("VALIDATION", "Your password is incorrect.");
    }
    if (await this.isTwoFactorEnabled(input.userId)) {
      const code = (input.code ?? "").trim();
      const ok = /^\d{6}$/.test(code) ? await this.verifyTotpForUser(input.userId, code) : code ? await this.useRecoveryCode(input.userId, code, input.ctx) : false;
      if (!ok) throw new AppError("VALIDATION", "Enter a valid authentication or recovery code.");
    }
    await markReauthenticated(this.db, input.sessionId);
  }

  static isRecentlyReauthenticated(reauthenticatedAt: Date | null): boolean {
    return !!reauthenticatedAt && Date.now() - reauthenticatedAt.getTime() < REAUTH_WINDOW_MS;
  }

  // -------------------------------------------------------------------------
  // Two-factor authentication (TOTP)
  // -------------------------------------------------------------------------

  async isTwoFactorEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db.select({ enabledAt: twoFactorSettings.enabledAt }).from(twoFactorSettings).where(eq(twoFactorSettings.userId, userId));
    return !!row?.enabledAt;
  }

  async getTwoFactorStatus(userId: string): Promise<{ enabled: boolean; enabledAt: Date | null; recoveryCodesRemaining: number }> {
    const [row] = await this.db.select({ enabledAt: twoFactorSettings.enabledAt }).from(twoFactorSettings).where(eq(twoFactorSettings.userId, userId));
    const [codes] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(twoFactorRecoveryCodes)
      .where(and(eq(twoFactorRecoveryCodes.userId, userId), isNull(twoFactorRecoveryCodes.usedAt)));
    return { enabled: !!row?.enabledAt, enabledAt: row?.enabledAt ?? null, recoveryCodesRemaining: codes?.n ?? 0 };
  }

  /** Step 1 of enrollment: generates a pending secret. 2FA is not active until confirmed. */
  async beginTwoFactorEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const [user] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user) throw new AppError("NOT_FOUND", "User not found.");
    if (await this.isTwoFactorEnabled(userId)) throw new AppError("CONFLICT", "Two-factor authentication is already enabled.");
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, `totp:${userId}`);
    await this.db
      .insert(twoFactorSettings)
      .values({ userId, pendingSecretEncrypted: encrypted, pendingCreatedAt: new Date() })
      .onConflictDoUpdate({ target: twoFactorSettings.userId, set: { pendingSecretEncrypted: encrypted, pendingCreatedAt: new Date(), updatedAt: new Date() } });
    const url = otpauthUrl({ secret, accountName: user.email, issuer: this.deps.config.issuer ?? "ResearchMate AI" });
    const qrCodeDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 220 });
    return { secret, otpauthUrl: url, qrCodeDataUrl };
  }

  /** Step 2: verifies a code from the pending secret, activates 2FA and returns one-time recovery codes. */
  async confirmTwoFactorEnrollment(input: { userId: string; sessionId: string; code: string; ctx?: SessionContext }): Promise<{ recoveryCodes: string[] }> {
    await enforceRateLimit(this.deps.limiter, `2fa-enroll:${input.userId}`, 10, 900);
    const codes = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(twoFactorSettings)
        .where(eq(twoFactorSettings.userId, input.userId))
        .for("update");
      if (!row?.pendingSecretEncrypted) throw new AppError("VALIDATION", "Start two-factor setup again.");
      if (row.enabledAt) throw new AppError("CONFLICT", "Two-factor authentication is already enabled.");
      if (row.pendingCreatedAt && Date.now() - row.pendingCreatedAt.getTime() > 30 * MINUTE) {
        throw new AppError("VALIDATION", "Setup expired. Start two-factor setup again.");
      }
      const secret = decryptSecret(row.pendingSecretEncrypted, `totp:${input.userId}`);
      const step = verifyTotp(secret, input.code ?? "");
      if (step === null) throw new AppError("VALIDATION", "That code is not valid. Check your authenticator app's clock and try again.");
      await tx
        .update(twoFactorSettings)
        .set({
          secretEncrypted: row.pendingSecretEncrypted,
          pendingSecretEncrypted: null,
          pendingCreatedAt: null,
          enabledAt: new Date(),
          lastUsedStep: step,
          updatedAt: new Date(),
        })
        .where(eq(twoFactorSettings.userId, input.userId));
      const recovery = await this.replaceRecoveryCodes(tx, input.userId);
      // Mark the current session as 2FA-verified and sign out everywhere else.
      await revokeAllSessions(tx, input.userId, input.sessionId);
      await tx.execute(sql`update sessions set two_factor_verified = true where id = ${input.sessionId}`);
      await this.event(tx, "two_factor.enabled", input.userId, input.ctx);
      return recovery;
    });
    return { recoveryCodes: codes };
  }

  /** Disabling requires the password and a current code (reauthentication). */
  async disableTwoFactor(input: { userId: string; sessionId: string; password: string; code: string; ctx?: SessionContext }): Promise<void> {
    await this.reauthenticate(input);
    await this.db.transaction(async (tx) => {
      await tx.delete(twoFactorSettings).where(eq(twoFactorSettings.userId, input.userId));
      await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, input.userId));
      await revokeAllSessions(tx, input.userId, input.sessionId);
      await this.event(tx, "two_factor.disabled", input.userId, input.ctx);
    });
  }

  async regenerateRecoveryCodes(input: { userId: string; sessionId: string; password: string; code: string; ctx?: SessionContext }): Promise<string[]> {
    if (!(await this.isTwoFactorEnabled(input.userId))) throw new AppError("VALIDATION", "Two-factor authentication is not enabled.");
    await this.reauthenticate(input);
    return this.db.transaction(async (tx) => {
      const codes = await this.replaceRecoveryCodes(tx, input.userId);
      await this.event(tx, "two_factor.recovery_codes_regenerated", input.userId, input.ctx);
      return codes;
    });
  }

  private async replaceRecoveryCodes(tx: DbOrTx, userId: string): Promise<string[]> {
    await tx.delete(twoFactorRecoveryCodes).where(eq(twoFactorRecoveryCodes.userId, userId));
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
    await tx.insert(twoFactorRecoveryCodes).values([...codes].map((c) => ({ userId, codeHash: recoveryCodeHash(userId, c) })));
    return [...codes];
  }

  /** Verifies a TOTP code with replay protection (each time-step is accepted once). */
  private async verifyTotpForUser(userId: string, code: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(twoFactorSettings).where(eq(twoFactorSettings.userId, userId)).for("update");
      if (!row?.enabledAt || !row.secretEncrypted) return false;
      const secret = decryptSecret(row.secretEncrypted, `totp:${userId}`);
      base32Decode(secret); // validates the stored secret
      const step = verifyTotp(secret, code);
      if (step === null) return false;
      if (row.lastUsedStep !== null && step <= row.lastUsedStep) return false; // replay
      await tx.update(twoFactorSettings).set({ lastUsedStep: step, updatedAt: new Date() }).where(eq(twoFactorSettings.userId, userId));
      return true;
    });
  }

  /** Recovery codes are single-use; the update is conditional so parallel use cannot succeed twice. */
  private async useRecoveryCode(userId: string, code: string, ctx?: SessionContext): Promise<boolean> {
    if (!code || code.replace(/[\s-]/g, "").length !== 10) return false;
    const [used] = await this.db
      .update(twoFactorRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(twoFactorRecoveryCodes.userId, userId), eq(twoFactorRecoveryCodes.codeHash, recoveryCodeHash(userId, code)), isNull(twoFactorRecoveryCodes.usedAt)))
      .returning({ id: twoFactorRecoveryCodes.id });
    if (!used) return false;
    await this.event(this.db, "two_factor.recovery_code_used", userId, ctx);
    return true;
  }
}
