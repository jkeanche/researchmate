import { afterAll, describe, expect, it } from "vitest";
import { listActiveSessions, revokeAllSessions, sessionIdFromToken, validateSession } from "@researchmate/auth";
import { authTokens, organizations, securityEvents, sessions, subscriptions, twoFactorSettings, users } from "@researchmate/database";
import { and, eq } from "drizzle-orm";
import { closeTestDb, codeFor, makeAuth, PASSWORD, testDb, uniqueEmail } from "./helpers";

afterAll(closeTestDb);

function tokenFromEmail(text: string, path: string) {
  const m = text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_%-]+)`));
  if (!m) throw new Error("token not found in email");
  return decodeURIComponent(m[1]!);
}

describe("registration", () => {
  it("creates a user, personal workspace on the Free plan, and sends a verification email", async () => {
    const { auth, mailer } = makeAuth({ requireEmailVerification: true });
    const email = uniqueEmail();
    const res = await auth.register({ email: `  ${email.toUpperCase()} `, password: PASSWORD, displayName: "Amina Otieno" });
    expect(res.status).toBe("verification_sent");

    const db = testDb();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user).toBeDefined();
    expect(user!.emailVerifiedAt).toBeNull();
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);

    const [org] = await db.select().from(organizations).where(eq(organizations.ownerUserId, user!.id));
    expect(org!.kind).toBe("personal");
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, org!.id));
    expect(subs).toHaveLength(1);

    expect(mailer.last(email)?.subject).toMatch(/Verify/);
  });

  it("does not reveal whether an email is already registered", async () => {
    const { auth, mailer } = makeAuth({ requireEmailVerification: true });
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD, displayName: "First" });
    const second = await auth.register({ email, password: PASSWORD, displayName: "Second" });
    expect(second.status).toBe("verification_sent");
    expect(mailer.last(email)?.subject).toMatch(/Sign-up attempt/);
  });

  it("blocks sign-in until the email is verified, then allows it", async () => {
    const { auth, mailer } = makeAuth({ requireEmailVerification: true });
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD, displayName: "Verifier" });
    await expect(auth.login({ email, password: PASSWORD })).rejects.toThrow(/Verify your email/);

    const token = tokenFromEmail(mailer.last(email)!.text, "/verify-email");
    await auth.verifyEmail(token);
    await expect(auth.verifyEmail(token)).rejects.toThrow(/invalid or has expired/); // single use
    const res = await auth.login({ email, password: PASSWORD });
    expect(res.status).toBe("signed_in");
  });

  it("rejects weak passwords", async () => {
    const { auth } = makeAuth();
    await expect(auth.register({ email: uniqueEmail(), password: "short", displayName: "X" })).rejects.toThrow(/at least/);
  });
});

describe("login and sessions", () => {
  it("returns a generic error for unknown email and wrong password", async () => {
    const { auth } = makeAuth();
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD, displayName: "Login User" });
    await expect(auth.login({ email, password: "wrong password here" })).rejects.toThrow("Incorrect email or password.");
    await expect(auth.login({ email: uniqueEmail(), password: PASSWORD })).rejects.toThrow("Incorrect email or password.");
  });

  it("rate-limits repeated failures per email", async () => {
    const { auth } = makeAuth();
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD, displayName: "Limited" });
    for (let i = 0; i < 8; i++) await expect(auth.login({ email, password: "nope nope nope" })).rejects.toThrow();
    await expect(auth.login({ email, password: PASSWORD })).rejects.toThrow(/Too many attempts/);
  });

  it("stores only a hash of the session token and validates it", async () => {
    const { auth } = makeAuth();
    const email = uniqueEmail();
    const res = await auth.register({ email, password: PASSWORD, displayName: "Session User" });
    if (res.status !== "signed_in") throw new Error();
    const db = testDb();
    const rows = await db.select().from(sessions).where(eq(sessions.userId, res.userId));
    expect(rows.some((r) => r.id === res.token)).toBe(false);
    expect(rows.some((r) => r.id === sessionIdFromToken(res.token))).toBe(true);
    const valid = await validateSession(db, res.token, 30);
    expect(valid?.user.email).toBe(email);
    expect(await validateSession(db, "not-a-real-token", 30)).toBeNull();
  });

  it("revokes sessions (logout, revoke-all, disabled users)", async () => {
    const { auth } = makeAuth();
    const email = uniqueEmail();
    const r1 = await auth.register({ email, password: PASSWORD, displayName: "Revoker" });
    if (r1.status !== "signed_in") throw new Error();
    const r2 = await auth.login({ email, password: PASSWORD });
    if (r2.status !== "signed_in") throw new Error();
    const db = testDb();
    const s1 = sessionIdFromToken(r1.token);

    expect(await listActiveSessions(db, r1.userId)).toHaveLength(2);
    await auth.revokeOtherSessions(r1.userId, s1);
    expect(await validateSession(db, r2.token, 30)).toBeNull();
    expect(await validateSession(db, r1.token, 30)).not.toBeNull();

    await db.update(users).set({ status: "disabled" }).where(eq(users.id, r1.userId));
    expect(await validateSession(db, r1.token, 30)).toBeNull();
    await db.update(users).set({ status: "active" }).where(eq(users.id, r1.userId));

    await auth.logout(s1, r1.userId);
    expect(await validateSession(db, r1.token, 30)).toBeNull();
  });
});

describe("password reset", () => {
  it("resets the password once, revokes all sessions, and does not leak account existence", async () => {
    const { auth, mailer } = makeAuth();
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: PASSWORD, displayName: "Forgetful" });
    if (reg.status !== "signed_in") throw new Error();

    await auth.requestPasswordReset(uniqueEmail()); // unknown email: silent
    await auth.requestPasswordReset(email);
    const token = tokenFromEmail(mailer.last(email)!.text, "/reset-password");

    await auth.resetPassword(token, "a brand new passphrase");
    await expect(auth.resetPassword(token, "another new passphrase")).rejects.toThrow(/invalid or has expired/);
    expect(await validateSession(testDb(), reg.token, 30)).toBeNull();
    await expect(auth.login({ email, password: PASSWORD })).rejects.toThrow();
    expect((await auth.login({ email, password: "a brand new passphrase" })).status).toBe("signed_in");
  });
});

describe("two-factor authentication", () => {
  async function enrolledUser() {
    const { auth, mailer } = makeAuth();
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: PASSWORD, displayName: "Two Factor" });
    if (reg.status !== "signed_in") throw new Error();
    const sessionId = sessionIdFromToken(reg.token);
    const enroll = await auth.beginTwoFactorEnrollment(reg.userId);
    expect(enroll.otpauthUrl).toContain("otpauth://totp/");
    expect(enroll.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    return { auth, mailer, email, userId: reg.userId, sessionId, token: reg.token, secret: enroll.secret };
  }

  it("is not active until a valid code confirms enrollment, and stores the secret encrypted", async () => {
    const u = await enrolledUser();
    expect(await u.auth.isTwoFactorEnabled(u.userId)).toBe(false);
    await expect(u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: "000000" })).rejects.toThrow(/not valid/);
    const { recoveryCodes } = await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });
    expect(recoveryCodes).toHaveLength(10);
    expect(await u.auth.isTwoFactorEnabled(u.userId)).toBe(true);
    const [row] = await testDb().select().from(twoFactorSettings).where(eq(twoFactorSettings.userId, u.userId));
    expect(row!.secretEncrypted).toMatch(/^v1:/);
    expect(row!.secretEncrypted).not.toContain(u.secret);
  });

  it("challenges at login, rejects replayed codes, and accepts a fresh code", async () => {
    const u = await enrolledUser();
    await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });

    const first = await u.auth.login({ email: u.email, password: PASSWORD });
    expect(first.status).toBe("two_factor_required");
    if (first.status !== "two_factor_required") throw new Error();
    // The code used for enrollment (same step) must not be accepted again.
    await expect(u.auth.completeTwoFactorLogin({ challengeToken: first.challengeToken, code: codeFor(u.secret) })).rejects.toThrow(/not valid/);
    const ok = await u.auth.completeTwoFactorLogin({ challengeToken: first.challengeToken, code: codeFor(u.secret, 1) });
    expect(ok.status).toBe("signed_in");
    const session = await validateSession(testDb(), ok.token, 30);
    expect(session?.twoFactorVerified).toBe(true);
    // A consumed challenge cannot be reused.
    await expect(u.auth.completeTwoFactorLogin({ challengeToken: first.challengeToken, code: codeFor(u.secret, 1) })).rejects.toThrow(/expired/);
  });

  it("recovery codes work exactly once", async () => {
    const u = await enrolledUser();
    const { recoveryCodes } = await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });
    const code = recoveryCodes[0]!;

    const a = await u.auth.login({ email: u.email, password: PASSWORD });
    if (a.status !== "two_factor_required") throw new Error();
    const res = await u.auth.completeTwoFactorLogin({ challengeToken: a.challengeToken, code: code.toLowerCase() });
    expect(res.usedRecoveryCode).toBe(true);

    const b = await u.auth.login({ email: u.email, password: PASSWORD });
    if (b.status !== "two_factor_required") throw new Error();
    await expect(u.auth.completeTwoFactorLogin({ challengeToken: b.challengeToken, code })).rejects.toThrow(/not valid/);
    expect((await u.auth.getTwoFactorStatus(u.userId)).recoveryCodesRemaining).toBe(9);
  });

  it("locks a challenge after five wrong codes", async () => {
    const u = await enrolledUser();
    await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });
    const a = await u.auth.login({ email: u.email, password: PASSWORD });
    if (a.status !== "two_factor_required") throw new Error();
    for (let i = 0; i < 5; i++) await expect(u.auth.completeTwoFactorLogin({ challengeToken: a.challengeToken, code: "000000" })).rejects.toThrow();
    await expect(u.auth.completeTwoFactorLogin({ challengeToken: a.challengeToken, code: codeFor(u.secret, 1) })).rejects.toThrow(/Too many|expired/);
  });

  it("disabling requires password and a valid code, and revokes other sessions", async () => {
    const u = await enrolledUser();
    await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });
    await expect(u.auth.disableTwoFactor({ userId: u.userId, sessionId: u.sessionId, password: "wrong password!", code: codeFor(u.secret, 1) })).rejects.toThrow(/password/);
    await expect(u.auth.disableTwoFactor({ userId: u.userId, sessionId: u.sessionId, password: PASSWORD, code: "123456" })).rejects.toThrow(/code/);
    await u.auth.disableTwoFactor({ userId: u.userId, sessionId: u.sessionId, password: PASSWORD, code: codeFor(u.secret, 1) });
    expect(await u.auth.isTwoFactorEnabled(u.userId)).toBe(false);
    expect((await u.auth.login({ email: u.email, password: PASSWORD })).status).toBe("signed_in");

    const events = await testDb().select({ type: securityEvents.type }).from(securityEvents).where(eq(securityEvents.userId, u.userId));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["two_factor.enabled", "two_factor.disabled"]));
  });

  it("regenerating recovery codes invalidates the old set", async () => {
    const u = await enrolledUser();
    const { recoveryCodes: old } = await u.auth.confirmTwoFactorEnrollment({ userId: u.userId, sessionId: u.sessionId, code: codeFor(u.secret) });
    const fresh = await u.auth.regenerateRecoveryCodes({ userId: u.userId, sessionId: u.sessionId, password: PASSWORD, code: codeFor(u.secret, 1) });
    expect(fresh).toHaveLength(10);
    const a = await u.auth.login({ email: u.email, password: PASSWORD });
    if (a.status !== "two_factor_required") throw new Error();
    await expect(u.auth.completeTwoFactorLogin({ challengeToken: a.challengeToken, code: old[0]! })).rejects.toThrow();
    expect((await u.auth.completeTwoFactorLogin({ challengeToken: a.challengeToken, code: fresh[0]! })).status).toBe("signed_in");
  });
});

describe("token hygiene", () => {
  it("never stores raw tokens", async () => {
    const { auth, mailer } = makeAuth({ requireEmailVerification: true });
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD, displayName: "Hygiene" });
    const raw = tokenFromEmail(mailer.last(email)!.text, "/verify-email");
    const rows = await testDb().select().from(authTokens).where(eq(authTokens.tokenHash, raw));
    expect(rows).toHaveLength(0);
  });

  it("revokeAllSessions affects only the target user", async () => {
    const { auth } = makeAuth();
    const a = await auth.register({ email: uniqueEmail(), password: PASSWORD, displayName: "A" });
    const b = await auth.register({ email: uniqueEmail(), password: PASSWORD, displayName: "B" });
    if (a.status !== "signed_in" || b.status !== "signed_in") throw new Error();
    await revokeAllSessions(testDb(), a.userId);
    expect(await validateSession(testDb(), b.token, 30)).not.toBeNull();
    const [s] = await testDb().select().from(sessions).where(and(eq(sessions.userId, a.userId)));
    expect(s!.revokedAt).not.toBeNull();
  });
});
