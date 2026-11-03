import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { researchProjects } from "./research";
import { organizations } from "./tenancy";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const orgRef = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export interface ApprovedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Registry of remote MCP servers (Streamable HTTP only; no local processes).
 * Nothing can be called until an organization admin reviews the discovered
 * tools and approves specific ones.
 */
export const mcpIntegrations = pgTable(
  "mcp_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgRef(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    authHeaderName: text("auth_header_name").notNull().default("Authorization"),
    /** Encrypted credential (e.g. "Bearer …"); never returned to the browser. */
    encryptedSecret: text("encrypted_secret"),
    secretHint: text("secret_hint"),
    status: text("status").notNull().default("pending_review"),
    enabled: boolean("enabled").notNull().default(false),
    toolCatalog: jsonb("tool_catalog").$type<ApprovedTool[]>().notNull().default([]),
    approvedTools: jsonb("approved_tools").$type<ApprovedTool[]>().notNull().default([]),
    timeoutMs: integer("timeout_ms").notNull().default(20_000),
    monthlyCallLimit: integer("monthly_call_limit"),
    maxResultChars: integer("max_result_chars").notNull().default(20_000),
    ownerUserId: userRef("owner_user_id"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_integrations_name_idx").on(t.organizationId, t.name),
    check("mcp_integrations_status_check", sql`${t.status} in ('pending_review', 'active', 'disabled', 'error')`),
    check("mcp_integrations_timeout_check", sql`${t.timeoutMs} between 1000 and 120000`),
    check("mcp_integrations_result_check", sql`${t.maxResultChars} between 500 and 200000`),
  ],
);

/** Every MCP tool call (allowed or blocked), append-only. */
export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgRef(),
    integrationId: uuid("integration_id").references(() => mcpIntegrations.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "set null" }),
    userId: userRef("user_id"),
    aiRunId: uuid("ai_run_id"),
    tool: text("tool").notNull(),
    argsDigest: text("args_digest").notNull(),
    argsPreview: text("args_preview").notNull().default(""),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    resultChars: integer("result_chars"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("mcp_tool_calls_integration_idx").on(t.integrationId, t.createdAt), check("mcp_tool_calls_status_check", sql`${t.status} in ('ok', 'error', 'blocked')`)],
);

export interface ActorField {
  type: "string" | "number" | "boolean" | "string[]" | "url[]";
  required?: boolean;
  max?: number;
  description?: string;
}

/** Platform-level allowlist of Apify Actors that may be run, with a strict input contract. */
export const apifyActors = pgTable(
  "apify_actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    actorId: text("actor_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    inputFields: jsonb("input_fields").$type<Record<string, ActorField>>().notNull(),
    /** Merged over the user's input; cannot be overridden. */
    fixedInput: jsonb("fixed_input").$type<Record<string, unknown>>().notNull().default({}),
    maxItems: integer("max_items").notNull().default(50),
    timeoutSecs: integer("timeout_secs").notNull().default(300),
    memoryMbytes: integer("memory_mbytes").notNull().default(1024),
    maxChargeMicros: bigint("max_charge_micros", { mode: "number" }).notNull(),
    normalizer: text("normalizer").notNull().default("generic"),
    enabled: boolean("enabled").notNull().default(false),
    notes: text("notes").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("apify_actors_key_idx").on(t.key), check("apify_actors_normalizer_check", sql`${t.normalizer} in ('web_pages', 'search_results', 'generic')`)],
);

/** An organization's own Apify account (its usage is billed by Apify, not by ResearchMate). */
export const apifyConnections = pgTable("apify_connections", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  encryptedToken: text("encrypted_token").notNull(),
  tokenHint: text("token_hint").notNull(),
  createdByUserId: userRef("created_by_user_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const apifyRuns = pgTable(
  "apify_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    userId: userRef("user_id"),
    actorKey: text("actor_key").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    funding: text("funding").notNull(),
    status: text("status").notNull().default("queued"),
    apifyRunId: text("apify_run_id"),
    datasetId: text("dataset_id"),
    itemCount: integer("item_count"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    chargeMicros: bigint("charge_micros", { mode: "number" }).notNull().default(0),
    estimatedChargeMicros: bigint("estimated_charge_micros", { mode: "number" }),
    results: jsonb("results").$type<Record<string, unknown>[]>(),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("apify_runs_project_idx").on(t.projectId, t.createdAt), check("apify_runs_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'aborted', 'timed_out')`), check("apify_runs_funding_check", sql`${t.funding} in ('byok', 'platform')`)],
);

/** Websites an organization approves for capture as research sources. */
export const approvedWebDomains = pgTable(
  "approved_web_domains",
  {
    organizationId: orgRef(),
    domain: text("domain").notNull(),
    addedByUserId: userRef("added_by_user_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.domain] }), check("approved_web_domains_check", sql`${t.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`)],
);
