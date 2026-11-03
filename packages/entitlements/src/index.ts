import {
  type DbOrTx,
  type EntitlementValue,
  FEATURES,
  type FeatureKey,
  type FlagKey,
  type LimitKey,
  type TierKey,
  fileStorageReservations,
  files,
  fileVersions,
  organizationEntitlementOverrides,
  organizationMembers,
  planEntitlements,
  plans,
  researchProjects,
  subscriptions,
} from "@researchmate/database";
import { AppError } from "@researchmate/shared";
import { and, count, eq, gt, inArray, isNull, or, sql, sum } from "drizzle-orm";

/**
 * Centralised entitlement service.
 *
 * Every plan-dependent decision in the application goes through this module.
 * Entitlements are resolved per organization (the billing tenant):
 *   live subscription plan → plan_entitlements, then admin overrides on top.
 * Organizations without a live subscription fall back to the default plan.
 *
 * Nothing here branches on plan names.
 */

export type { FeatureKey, FlagKey, LimitKey, TierKey };

export interface ResolvedEntitlements {
  planId: string;
  planKey: string;
  planName: string;
  subscriptionStatus: string | null;
  values: Record<FeatureKey, EntitlementValue>;
}

const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;

export async function getEntitlements(db: DbOrTx, organizationId: string): Promise<ResolvedEntitlements> {
  const [sub] = await db
    .select({ planId: subscriptions.planId, status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.status, [...LIVE_STATUSES])))
    .limit(1);

  let plan: { id: string; key: string; name: string } | undefined;
  if (sub) {
    [plan] = await db.select({ id: plans.id, key: plans.key, name: plans.name }).from(plans).where(eq(plans.id, sub.planId));
  }
  if (!plan) {
    [plan] = await db
      .select({ id: plans.id, key: plans.key, name: plans.name })
      .from(plans)
      .where(eq(plans.isDefault, true))
      .limit(1);
  }
  if (!plan) throw new AppError("INTERNAL", "No default plan is configured. Run database migrations and seed.");

  const rows = await db
    .select({ featureKey: planEntitlements.featureKey, value: planEntitlements.value })
    .from(planEntitlements)
    .where(eq(planEntitlements.planId, plan.id));

  const overrides = await db
    .select({ featureKey: organizationEntitlementOverrides.featureKey, value: organizationEntitlementOverrides.value })
    .from(organizationEntitlementOverrides)
    .where(
      and(
        eq(organizationEntitlementOverrides.organizationId, organizationId),
        or(isNull(organizationEntitlementOverrides.expiresAt), gt(organizationEntitlementOverrides.expiresAt, sql`now()`)),
      ),
    );

  const values = {} as Record<FeatureKey, EntitlementValue>;
  // Default every known feature to "not available" so a missing row never grants access.
  for (const [key, def] of Object.entries(FEATURES) as [FeatureKey, (typeof FEATURES)[FeatureKey]][]) {
    values[key] = def.kind === "limit" ? 0 : def.kind === "flag" ? false : def.tiers[0]!;
  }
  for (const r of [...rows, ...overrides]) {
    if (r.featureKey in FEATURES) values[r.featureKey as FeatureKey] = normalise(r.featureKey as FeatureKey, r.value);
  }

  return { planId: plan.id, planKey: plan.key, planName: plan.name, subscriptionStatus: sub?.status ?? null, values };
}

function normalise(key: FeatureKey, value: EntitlementValue): EntitlementValue {
  const def = FEATURES[key];
  if (def.kind === "limit") return value === null ? null : typeof value === "number" && value >= 0 ? value : 0;
  if (def.kind === "flag") return value === true;
  return typeof value === "string" && (def.tiers as readonly string[]).includes(value) ? value : def.tiers[0]!;
}

/** Numeric limit; `null` means unlimited. */
export function limitOf(ent: ResolvedEntitlements, key: LimitKey): number | null {
  const v = ent.values[key];
  return v === null ? null : (v as number);
}

export function tierOf(ent: ResolvedEntitlements, key: TierKey): string {
  return ent.values[key] as string;
}

/** True when the tier is at least `minTier` (tiers are ordered in the catalogue). */
export function hasTier(ent: ResolvedEntitlements, key: TierKey, minTier: string): boolean {
  const tiers = FEATURES[key].tiers as readonly string[];
  const want = tiers.indexOf(minTier);
  if (want < 0) throw new Error(`Unknown tier ${minTier} for ${key}`);
  return tiers.indexOf(tierOf(ent, key)) >= want;
}

/** A flag is on, or a tier is above its "not available" level. Limits are usable when non-zero. */
export function featureEnabled(ent: ResolvedEntitlements, key: FeatureKey): boolean {
  const def = FEATURES[key];
  const v = ent.values[key];
  if (def.kind === "flag") return v === true;
  if (def.kind === "tier") return v !== def.tiers[0];
  return v === null || (typeof v === "number" && v > 0);
}

export async function canUseFeature(db: DbOrTx, organizationId: string, key: FeatureKey): Promise<boolean> {
  return featureEnabled(await getEntitlements(db, organizationId), key);
}

export async function requireFeature(db: DbOrTx, organizationId: string, key: FeatureKey, minTier?: string): Promise<ResolvedEntitlements> {
  const ent = await getEntitlements(db, organizationId);
  const def = FEATURES[key];
  const ok = minTier && def.kind === "tier" ? hasTier(ent, key as TierKey, minTier) : featureEnabled(ent, key);
  if (!ok) {
    throw new AppError("FEATURE_NOT_ENTITLED", `${def.description} is not included in the ${ent.planName} plan.`, {
      feature: key,
      plan: ent.planKey,
    });
  }
  return ent;
}

export type IntegrationKey = "google_drive" | "mcp" | "apify";

export async function checkIntegrationAccess(db: DbOrTx, organizationId: string, integration: IntegrationKey): Promise<void> {
  await requireFeature(db, organizationId, `integrations.${integration}` as FlagKey);
}

// ---------------------------------------------------------------------------
// Usage and quotas
// ---------------------------------------------------------------------------

export interface OrganizationUsage {
  projects: number;
  files: number;
  /** Bytes of every stored version of every non-deleted file. */
  storageBytes: number;
  /** Bytes held by in-flight upload reservations. */
  reservedBytes: number;
  /** File slots held by in-flight upload reservations. */
  reservedFiles: number;
  members: number;
}

export async function getUsage(db: DbOrTx, organizationId: string): Promise<OrganizationUsage> {
  const [[p], [f], [s], [r], [m]] = await Promise.all([
    db.select({ n: count() }).from(researchProjects).where(eq(researchProjects.organizationId, organizationId)),
    db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.organizationId, organizationId), isNull(files.deletedAt))),
    db
      .select({ bytes: sum(fileVersions.sizeBytes) })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(files.organizationId, organizationId), isNull(files.deletedAt))),
    db
      .select({
        bytes: sum(fileStorageReservations.bytes),
        n: sql<number>`count(*) filter (where ${fileStorageReservations.countsAsFile})`.mapWith(Number),
      })
      .from(fileStorageReservations)
      .where(
        and(
          eq(fileStorageReservations.organizationId, organizationId),
          eq(fileStorageReservations.status, "active"),
          gt(fileStorageReservations.expiresAt, sql`now()`),
        ),
      ),
    db.select({ n: count() }).from(organizationMembers).where(eq(organizationMembers.organizationId, organizationId)),
  ]);
  return {
    projects: p?.n ?? 0,
    files: f?.n ?? 0,
    storageBytes: Number(s?.bytes ?? 0),
    reservedBytes: Number(r?.bytes ?? 0),
    reservedFiles: r?.n ?? 0,
    members: m?.n ?? 0,
  };
}

function within(limit: number | null, used: number, adding: number): boolean {
  return limit === null || used + adding <= limit;
}

/**
 * Project quota. All projects count (including archived) so archiving cannot
 * be used to bypass plan limits; nothing is ever deleted on downgrade.
 * Callers that create projects should hold the organization lock (see
 * lockOrganization) to make the check race-free.
 */
export async function checkProjectQuota(db: DbOrTx, organizationId: string): Promise<void> {
  const [ent, usage] = await Promise.all([getEntitlements(db, organizationId), getUsage(db, organizationId)]);
  const limit = limitOf(ent, "projects.max");
  if (!within(limit, usage.projects, 1)) {
    throw new AppError("QUOTA_EXCEEDED", `Your ${ent.planName} plan allows ${limit} project${limit === 1 ? "" : "s"}. Upgrade to create more.`, {
      feature: "projects.max",
      limit,
      used: usage.projects,
    });
  }
}

export interface UploadQuotaCheck {
  sizeBytes: number;
  /** false when uploading a new version of an existing file. */
  newFile: boolean;
}

/** File-size, file-count and storage checks. Must run while holding the organization lock. */
export async function checkUploadQuota(db: DbOrTx, organizationId: string, input: UploadQuotaCheck): Promise<ResolvedEntitlements> {
  const [ent, usage] = await Promise.all([getEntitlements(db, organizationId), getUsage(db, organizationId)]);
  const maxFile = limitOf(ent, "files.max_size_bytes");
  if (maxFile !== null && input.sizeBytes > maxFile) {
    throw new AppError("QUOTA_EXCEEDED", `Files on the ${ent.planName} plan can be at most ${formatBytes(maxFile)}.`, {
      feature: "files.max_size_bytes",
      limit: maxFile,
    });
  }
  const maxFiles = limitOf(ent, "files.max");
  if (input.newFile && !within(maxFiles, usage.files + usage.reservedFiles, 1)) {
    throw new AppError("QUOTA_EXCEEDED", `Your ${ent.planName} plan allows ${maxFiles} file${maxFiles === 1 ? "" : "s"}. Delete a file or upgrade.`, {
      feature: "files.max",
      limit: maxFiles,
      used: usage.files,
    });
  }
  const maxStorage = limitOf(ent, "storage.max_bytes");
  if (!within(maxStorage, usage.storageBytes + usage.reservedBytes, input.sizeBytes)) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      `This upload would exceed your ${formatBytes(maxStorage ?? 0)} storage allowance (${formatBytes(usage.storageBytes)} used).`,
      { feature: "storage.max_bytes", limit: maxStorage, used: usage.storageBytes },
    );
  }
  return ent;
}

export async function checkFileQuota(db: DbOrTx, organizationId: string, fileSizeBytes: number) {
  return checkUploadQuota(db, organizationId, { sizeBytes: fileSizeBytes, newFile: true });
}

export async function checkStorageQuota(db: DbOrTx, organizationId: string, additionalBytes: number) {
  return checkUploadQuota(db, organizationId, { sizeBytes: additionalBytes, newFile: false });
}

export async function checkMemberQuota(db: DbOrTx, organizationId: string): Promise<void> {
  const [ent, usage] = await Promise.all([getEntitlements(db, organizationId), getUsage(db, organizationId)]);
  const limit = limitOf(ent, "members.max");
  if (!within(limit, usage.members, 1)) {
    throw new AppError("QUOTA_EXCEEDED", `Your ${ent.planName} plan allows ${limit} member${limit === 1 ? "" : "s"}.`, {
      feature: "members.max",
      limit,
    });
  }
}

/**
 * Downgrade policy: organizations above a limit keep full read and download
 * access to everything they own. Creation that would add to an exceeded limit
 * is blocked by the quota checks above. Nothing is deleted automatically.
 */
export interface LimitStatus {
  key: LimitKey;
  limit: number | null;
  used: number;
  over: boolean;
}

export async function getLimitStatus(db: DbOrTx, organizationId: string): Promise<{ entitlements: ResolvedEntitlements; usage: OrganizationUsage; limits: LimitStatus[] }> {
  const [entitlements, usage] = await Promise.all([getEntitlements(db, organizationId), getUsage(db, organizationId)]);
  const used: Record<LimitKey, number> = {
    "projects.max": usage.projects,
    "files.max": usage.files,
    "files.max_size_bytes": 0,
    "storage.max_bytes": usage.storageBytes,
    "members.max": usage.members,
    "planning.tasks.max": 0, // per project; reported on the project's planning pages
    "ai.runs.monthly": 0, // reported on the AI pages
    "ai.platform.allowance": 0, // reported on the billing page
  };
  const limits = (Object.keys(used) as LimitKey[]).map((key) => {
    const limit = limitOf(entitlements, key);
    return { key, limit, used: used[key], over: limit !== null && key !== "files.max_size_bytes" && key !== "planning.tasks.max" && key !== "ai.runs.monthly" && key !== "ai.platform.allowance" && used[key] > limit };
  });
  return { entitlements, usage, limits };
}

/**
 * Serialises quota-sensitive writes for one organization for the rest of the
 * current transaction (row lock on the organization).
 */
export async function lockOrganization(tx: DbOrTx, organizationId: string): Promise<void> {
  const rows = await tx.execute(sql`select id from organizations where id = ${organizationId} and deleted_at is null for update`);
  if (rows.length === 0) throw new AppError("NOT_FOUND", "Organization not found.");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}
