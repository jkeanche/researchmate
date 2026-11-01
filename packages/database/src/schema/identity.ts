import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Always stored lower-cased and trimmed. */
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: ts("email_verified_at"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    status: text("status").notNull().default("active"),
    lastLoginAt: ts("last_login_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    check("users_status_check", sql`${t.status} in ('active', 'disabled')`),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  institution: text("institution"),
  department: text("department"),
  discipline: text("discipline"),
  academicLevel: text("academic_level"),
  timezone: text("timezone").notNull().default("UTC"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Sessions. The primary key is an HMAC of the session token; the raw token
 * only ever exists in the user's httpOnly cookie.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    /** True when the session was created after a successful second factor. */
    twoFactorVerified: boolean("two_factor_verified").notNull().default(false),
    /** Last time the user re-entered their password/2FA in this session (for sensitive actions). */
    reauthenticatedAt: ts("reauthenticated_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** Single-use, expiring tokens: email verification, password reset and pending 2FA login challenges. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    /** Failed attempts against this token (2FA challenges). */
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_unique").on(t.tokenHash),
    index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose),
    check(
      "auth_tokens_purpose_check",
      sql`${t.purpose} in ('email_verification', 'password_reset', 'two_factor_challenge')`,
    ),
  ],
);

export const twoFactorSettings = pgTable("two_factor_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM encrypted TOTP secret once 2FA is active. */
  secretEncrypted: text("secret_encrypted"),
  /** Secret awaiting verification during enrollment. */
  pendingSecretEncrypted: text("pending_secret_encrypted"),
  pendingCreatedAt: ts("pending_created_at"),
  enabledAt: ts("enabled_at"),
  /** Highest TOTP time-step accepted; prevents replay of a code within its window. */
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const twoFactorRecoveryCodes = pgTable(
  "two_factor_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId), uniqueIndex("recovery_codes_hash_unique").on(t.codeHash)],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("security_events_user_idx").on(t.userId, t.createdAt)],
);
