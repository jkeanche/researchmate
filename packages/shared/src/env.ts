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
    /** Optional ClamAV daemon. When set, every upload is scanned and refused if infected or if the scanner is down. */
    CLAMAV_HOST: optionalString,
    CLAMAV_PORT: z.coerce.number().int().positive().max(65535).default(3310),

    S3_BUCKET: optionalString,
    S3_REGION: optionalString,
    S3_ENDPOINT: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    /** Path-style addressing (bucket in the path). Needed by MinIO and most self-hosted S3 servers. */
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    /** Optional key prefix so several environments can share one bucket. */
    S3_KEY_PREFIX: optionalString,

    EMAIL_HOST: optionalString,
    EMAIL_PORT: z.coerce.number().int().positive().optional(),
    EMAIL_USERNAME: optionalString,
    EMAIL_PASSWORD: optionalString,
    EMAIL_FROM: z.string().default("ResearchMate AI <no-reply@localhost>"),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: optionalString,
    /** drive.file (default, recommended) or drive.readonly (needs Google verification). */
    GOOGLE_DRIVE_SCOPE: z.enum(["drive.file", "drive.readonly"]).default("drive.file"),
    /** Allow AI/MCP endpoints on private networks (e.g. a self-hosted model on the same VPS). */
    ALLOW_PRIVATE_ENDPOINTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Platform-funded AI: off unless enabled and a model, key and price are configured. */
    PLATFORM_AI_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    PLATFORM_AI_PROVIDER: z.enum(["openai", "anthropic", "google", "openai_compatible"]).optional(),
    PLATFORM_AI_MODEL: optionalString,
    PLATFORM_AI_API_KEY: optionalString,
    PLATFORM_AI_BASE_URL: optionalString,
    PLATFORM_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(4000),

    /** Payment providers: each is enabled when its keys are set. */
    PAYSTACK_SECRET_KEY: optionalString,
    PAYSTACK_CURRENCIES: optionalString,
    PAYSTACK_BASE_URL: optionalString,
    PESAPAL_CONSUMER_KEY: optionalString,
    PESAPAL_CONSUMER_SECRET: optionalString,
    PESAPAL_IPN_ID: optionalString,
    PESAPAL_CURRENCIES: optionalString,
    PESAPAL_BASE_URL: optionalString,
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
    STRIPE_CURRENCIES: optionalString,
    STRIPE_BASE_URL: optionalString,
    /** Days after a paid period ends before the organization returns to the default plan. */
    /** Seller details printed on invoices, lines separated by "|" (name | address | tax registration). */
    INVOICE_ISSUER: optionalString,
    /** Platform Apify token (usage charged to credit at the "apify.usage" price). Organizations can connect their own instead. */
    APIFY_TOKEN: optionalString,
    /** Bearer token for GET /api/metrics (Prometheus). Unset = endpoint disabled (404). */
    METRICS_TOKEN: optionalString.refine((v) => !v || v.length >= 24, "must be at least 24 characters"),
    /** Websites every organization may capture as sources (comma-separated domains). */
    WEB_APPROVED_DOMAINS: optionalString,
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(3),

    /** OCR scanned PDFs with Tesseract when installed (worker only). */
    OCR_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Contact email sent to Crossref, OpenAlex and NCBI for their "polite" access pools. */
    SCHOLARLY_CONTACT_EMAIL: optionalString,
    /** Optional Semantic Scholar API key (higher rate limits). */
    SEMANTIC_SCHOLAR_API_KEY: optionalString,

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
      // Plain http is only tolerated on loopback (local production-mode testing).
      const host = new URL(env.APP_URL).hostname;
      const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      if (!env.APP_URL.startsWith("https://") && !loopback) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_URL"], message: "must use https in production" });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export class EnvValidationError extends Error {}

/**
 * Accepts the variable names from the original specification (§35) as
 * aliases of the names the app reads, so either set works:
 *   DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL     → PLATFORM_AI_PROVIDER / PLATFORM_AI_MODEL
 *   OPENAI_API_KEY | ANTHROPIC_API_KEY | GOOGLE_AI_API_KEY → PLATFORM_AI_API_KEY (for that provider)
 *   APIFY_API_TOKEN                            → APIFY_TOKEN
 * PAYMENT_PROVIDER is read by providersFromEnv (preferred provider first).
 * The explicit names win when both are set.
 */
export function applyEnvAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const s = { ...source };
  const set = (k: string, v: string | undefined) => {
    if (!s[k] && v) s[k] = v;
  };
  set("PLATFORM_AI_PROVIDER", s.DEFAULT_AI_PROVIDER);
  set("PLATFORM_AI_MODEL", s.DEFAULT_AI_MODEL);
  const keyFor: Record<string, string | undefined> = { openai: s.OPENAI_API_KEY, anthropic: s.ANTHROPIC_API_KEY, google: s.GOOGLE_AI_API_KEY };
  if (s.PLATFORM_AI_PROVIDER) set("PLATFORM_AI_API_KEY", keyFor[s.PLATFORM_AI_PROVIDER]);
  set("APIFY_TOKEN", s.APIFY_API_TOKEN);
  return s;
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(applyEnvAliases(source));
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


/** The platform-funded model, when fully configured and enabled. */
export function platformModelFromEnv(e: ReturnType<typeof env>) {
  if (!e.PLATFORM_AI_ENABLED || !e.PLATFORM_AI_PROVIDER || !e.PLATFORM_AI_MODEL || !e.PLATFORM_AI_API_KEY) return null;
  return { providerKey: e.PLATFORM_AI_PROVIDER, modelId: e.PLATFORM_AI_MODEL, apiKey: e.PLATFORM_AI_API_KEY, baseUrl: e.PLATFORM_AI_BASE_URL ?? null };
}
