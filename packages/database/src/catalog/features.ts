/**
 * Feature catalogue: every entitlement key the platform understands.
 *
 * Values live in the database (plan_entitlements / overrides). This file only
 * defines which keys exist and how their values are interpreted, so the
 * application never branches on plan names.
 */

export type FeatureDefinition =
  | { kind: "limit"; description: string; unit: "count" | "bytes" }
  | { kind: "flag"; description: string }
  | { kind: "tier"; description: string; tiers: readonly string[] };

export const FEATURES = {
  // Numeric limits. `null` means unlimited.
  "projects.max": { kind: "limit", unit: "count", description: "Active research projects per organization" },
  "files.max": { kind: "limit", unit: "count", description: "Managed files per organization" },
  "files.max_size_bytes": { kind: "limit", unit: "bytes", description: "Maximum size of a single uploaded file" },
  "storage.max_bytes": { kind: "limit", unit: "bytes", description: "Total managed storage per organization" },
  "members.max": { kind: "limit", unit: "count", description: "Organization members" },

  // Tiered capabilities. The first tier always means "not available".
  "ai.agents": { kind: "tier", tiers: ["none", "limited", "full"], description: "AI agents and workflows" },
  "research.web": { kind: "tier", tiers: ["none", "limited", "full"], description: "Web and scholarly research automation" },
  "planning.gantt": { kind: "tier", tiers: ["none", "overview", "full"], description: "Gantt and project planning" },
  "toolkit": { kind: "tier", tiers: ["none", "basic", "advanced"], description: "Research toolkit" },
  "citations.audit": { kind: "tier", tiers: ["none", "basic", "advanced"], description: "Citation audit" },
  "documents.generation": { kind: "tier", tiers: ["none", "basic", "advanced"], description: "Document generation" },
  "collaboration.supervisor": { kind: "tier", tiers: ["none", "limited", "full"], description: "Supervisor collaboration" },
  "collaboration.team": { kind: "tier", tiers: ["none", "limited", "full"], description: "Team collaboration" },

  // Flags.
  "ai.embeddings": { kind: "flag", description: "Embedding generation for uploaded documents" },
  "ai.document_processing": { kind: "flag", description: "Text extraction / OCR / AI processing of uploads" },
  "finance.budget": { kind: "flag", description: "Optional project budget and expense management" },
  "integrations.google_drive": { kind: "flag", description: "Google Drive import and export" },
  "integrations.mcp": { kind: "flag", description: "MCP integrations" },
  "integrations.apify": { kind: "flag", description: "Apify actor execution" },
  "api.access": { kind: "flag", description: "External API access" },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;
export type LimitKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { kind: "limit" } ? K : never }[FeatureKey];
export type FlagKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { kind: "flag" } ? K : never }[FeatureKey];
export type TierKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { kind: "tier" } ? K : never }[FeatureKey];

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface PlanSeed {
  key: string;
  name: string;
  description: string;
  priceMinor: number;
  sortOrder: number;
  isDefault?: boolean;
  entitlements: Record<FeatureKey, boolean | number | string | null>;
}

/**
 * Initial plan catalogue (spec §22). Prices and limits are configurable in
 * the database; this is only the seed. "Optional" items in the spec are
 * modelled as `false` and can be enabled per organization as a paid add-on
 * through entitlement overrides.
 */
export const PLAN_SEEDS: PlanSeed[] = [
  {
    key: "free",
    name: "Free",
    description: "Overview of ResearchMate: one project and one small file, no AI processing.",
    priceMinor: 0,
    sortOrder: 0,
    isDefault: true,
    entitlements: {
      "projects.max": 1,
      "files.max": 1,
      "files.max_size_bytes": 5 * MB,
      "storage.max_bytes": 5 * MB,
      "members.max": 1,
      "ai.agents": "none",
      "research.web": "none",
      "planning.gantt": "overview",
      "toolkit": "none",
      "citations.audit": "none",
      "documents.generation": "none",
      "collaboration.supervisor": "none",
      "collaboration.team": "none",
      "ai.embeddings": false,
      "ai.document_processing": false,
      "finance.budget": false,
      "integrations.google_drive": false,
      "integrations.mcp": false,
      "integrations.apify": false,
      "api.access": false,
    },
  },
  {
    key: "starter",
    name: "Starter",
    description: "For individual researchers getting started with planning and limited AI assistance.",
    priceMinor: 900,
    sortOrder: 1,
    entitlements: {
      "projects.max": 3,
      "files.max": 25,
      "files.max_size_bytes": 20 * MB,
      "storage.max_bytes": 500 * MB,
      "members.max": 3,
      "ai.agents": "limited",
      "research.web": "limited",
      "planning.gantt": "full",
      "toolkit": "basic",
      "citations.audit": "basic",
      "documents.generation": "basic",
      "collaboration.supervisor": "limited",
      "collaboration.team": "none",
      "ai.embeddings": true,
      "ai.document_processing": true,
      "finance.budget": false,
      "integrations.google_drive": false,
      "integrations.mcp": false,
      "integrations.apify": false,
      "api.access": false,
    },
  },
  {
    key: "research_pro",
    name: "Research Pro",
    description: "Full research workflow for postgraduate and professional researchers.",
    priceMinor: 2500,
    sortOrder: 2,
    entitlements: {
      "projects.max": 15,
      "files.max": 250,
      "files.max_size_bytes": 50 * MB,
      "storage.max_bytes": 10 * GB,
      "members.max": 5,
      "ai.agents": "full",
      "research.web": "full",
      "planning.gantt": "full",
      "toolkit": "advanced",
      "citations.audit": "advanced",
      "documents.generation": "advanced",
      "collaboration.supervisor": "full",
      "collaboration.team": "limited",
      "ai.embeddings": true,
      "ai.document_processing": true,
      "finance.budget": true,
      "integrations.google_drive": true,
      "integrations.mcp": true,
      "integrations.apify": false,
      "api.access": false,
    },
  },
  {
    key: "research_team",
    name: "Research Team",
    description: "For research groups, departments and institutions.",
    priceMinor: 7900,
    sortOrder: 3,
    entitlements: {
      "projects.max": 50,
      "files.max": 1000,
      "files.max_size_bytes": 100 * MB,
      "storage.max_bytes": 50 * GB,
      "members.max": 50,
      "ai.agents": "full",
      "research.web": "full",
      "planning.gantt": "full",
      "toolkit": "advanced",
      "citations.audit": "advanced",
      "documents.generation": "advanced",
      "collaboration.supervisor": "full",
      "collaboration.team": "full",
      "ai.embeddings": true,
      "ai.document_processing": true,
      "finance.budget": true,
      "integrations.google_drive": true,
      "integrations.mcp": true,
      "integrations.apify": true,
      "api.access": true,
    },
  },
];
