import { z } from "zod";

/**
 * Validated environment configuration.
 *
 * Secrets have no defaults. The application refuses to start if a required
 * secret is missing or malformed, in every environment, so a misconfigured
 * production deploy fails loudly instead of running with weak defaults.
 */

const base64Key32 = z
  .string({ required_error: "is required (32 random bytes, base64). Generate with: openssl rand -base64 32" })
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be exactly 32 bytes encoded as base64 (openssl rand -base64 32)");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    APP_SECRET: z
      .string({ required_error: "is required (min 32 chars). Generate with: openssl rand -base64 48" })
      .min(32, "must be at least 32 characters"),
    ENCRYPTION_KEY: base64Key32,

    DATABASE_URL: z.string({ required_error: "is required" }).url(),
    REDIS_URL: z.string({ required_error: "is required" }).url(),

    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    LOCAL_STORAGE_ROOT: z.string().default("/var/lib/researchmate"),
    MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().max(2048).default(50),

    S3_BUCKET: optionalString,
    S3_REGION: optionalString,
    S3_ENDPOINT: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,

    EMAIL_HOST: optionalString,
    EMAIL_PORT: z.coerce.number().int().positive().optional(),
    EMAIL_USERNAME: optionalString,
    EMAIL_PASSWORD: optionalString,
    EMAIL_FROM: z.string().default("ResearchMate AI <no-reply@localhost>"),

    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),

    /** When true, new accounts must verify email before signing in. */
    REQUIRE_EMAIL_VERIFICATION: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Session lifetime in days (sliding). */
    SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(30),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "s3") {
      for (const key of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "is required when STORAGE_DRIVER=s3" });
      }
    }
    if (env.NODE_ENV === "production") {
      if (!env.EMAIL_HOST) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["EMAIL_HOST"], message: "is required in production (verification and password-reset emails)" });
      }
      if (!env.APP_URL.startsWith("https://")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_URL"], message: "must use https in production" });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export class EnvValidationError extends Error {}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"} ${i.message}`);
    throw new EnvValidationError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Returns the validated environment, parsing it once. */
export function env(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test helper: drop the cached environment so a new one is parsed. */
export function resetEnvCache(): void {
  cached = undefined;
}
