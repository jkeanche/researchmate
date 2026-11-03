import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });

export const AI_PROVIDERS = ["openai", "anthropic", "google", "openai_compatible"] as const;

/**
 * Model catalogue maintained by platform administrators. Prices are per
 * million tokens in micro-USD and are NULL until an administrator enters the
 * provider's current price; unpriced models are never used for
 * platform-funded AI.
 */
export const aiModels = pgTable(
  "ai_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerKey: text("provider_key").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    inputPricePerMTokMicros: bigint("input_price_per_mtok_micros", { mode: "number" }),
    outputPricePerMTokMicros: bigint("output_price_per_mtok_micros", { mode: "number" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_models_provider_model_idx").on(t.providerKey, t.modelId), check("ai_models_provider_check", sql`${t.providerKey} in (${inList(AI_PROVIDERS)})`)],
);

/** Bring-your-own-key credentials. The key is AES-256-GCM encrypted and never returned to the browser. */
export const userApiCredentials = pgTable(
  "user_api_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Owner. For organization-scoped keys, the admin who added it. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user"),
    providerKey: text("provider_key").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url"),
    defaultModel: text("default_model").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    keyHint: text("key_hint").notNull(),
    lastUsedAt: ts("last_used_at"),
    lastError: text("last_error"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("user_api_credentials_org_idx").on(t.organizationId),
    check("user_api_credentials_scope_check", sql`${t.scope} in ('user', 'organization')`),
    check("user_api_credentials_provider_check", sql`${t.providerKey} in (${inList(AI_PROVIDERS)})`),
  ],
);

export const AI_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/** One agent or workflow execution (workflow_executions in the blueprint). */
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "cascade" }),
    userId: userRef("user_id"),
    agentKey: text("agent_key").notNull(),
    status: text("status").notNull().default("queued"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown> | null>(),
    error: text("error"),
    /** byok = the user's own key (never charged by the platform); platform = platform-funded. */
    funding: text("funding").notNull(),
    credentialId: uuid("credential_id").references(() => userApiCredentials.id, { onDelete: "set null" }),
    providerKey: text("provider_key").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Provider cost estimate in micro-USD when the model has a price; null if unknown. */
    providerCostMicros: bigint("provider_cost_micros", { mode: "number" }),
    customerChargeMicros: bigint("customer_charge_micros", { mode: "number" }).notNull().default(0),
    /** Pricing version used for the cost estimate and (platform runs) the charge. */
    pricingVersionId: uuid("pricing_version_id"),
    /** Platform runs: the budget reserved when the run was queued. */
    estimatedChargeMicros: bigint("estimated_charge_micros", { mode: "number" }),
    toolCalls: jsonb("tool_calls").$type<{ tool: string; args: unknown }[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    durationMs: integer("duration_ms"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_runs_project_idx").on(t.projectId, t.createdAt),
    index("ai_runs_org_month_idx").on(t.organizationId, t.createdAt),
    check("ai_runs_status_check", sql`${t.status} in (${inList(AI_RUN_STATUSES)})`),
    check("ai_runs_funding_check", sql`${t.funding} in ('byok', 'platform')`),
    check("ai_runs_tokens_check", sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`),
  ],
);

export const aiRunSteps = pgTable(
  "ai_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    status: text("status").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_run_steps_run_idx").on(t.runId, t.createdAt)],
);

export const SUGGESTION_KINDS = ["research_question", "objective", "risk", "task", "evidence", "matrix_entry", "revision_task"] as const;

/** AI output awaiting a human decision. Accepting creates the real record through the normal service. */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    createdRecordId: uuid("created_record_id"),
    decidedByUserId: userRef("decided_by_user_id"),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_suggestions_project_idx").on(t.projectId, t.status),
    check("ai_suggestions_kind_check", sql`${t.kind} in (${inList(SUGGESTION_KINDS)})`),
    check("ai_suggestions_status_check", sql`${t.status} in ('pending', 'accepted', 'dismissed')`),
  ],
);

/** Generic metering (AI tokens now; OCR, crawling and external APIs later). */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "set null" }),
    userId: userRef("user_id"),
    kind: text("kind").notNull(),
    funding: text("funding").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    providerCostMicros: bigint("provider_cost_micros", { mode: "number" }),
    customerChargeMicros: bigint("customer_charge_micros", { mode: "number" }).notNull().default(0),
    pricingVersionId: uuid("pricing_version_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("usage_records_org_idx").on(t.organizationId, t.createdAt),
    // One record per source item and kind: metering is idempotent under retries.
    uniqueIndex("usage_records_source_idx").on(t.sourceType, t.sourceId, t.kind),
  ],
);
