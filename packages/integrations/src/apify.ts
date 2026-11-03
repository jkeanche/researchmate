import { customerPrice, LedgerService } from "@researchmate/billing";
import { type ActorField, apifyActors, apifyConnections, apifyRuns, type Database } from "@researchmate/database";
import { featureEnabled, getEntitlements } from "@researchmate/entitlements";
import { AppError, assertSafeOutboundUrl, decryptSecret, encryptSecret, logger } from "@researchmate/shared";
import { getProjectAccess, recordAudit, requireOrgPermission } from "@researchmate/tenancy";
import { and, desc, eq } from "drizzle-orm";

const AAD = (orgId: string) => `apify-token:${orgId}`;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const MAX_TEXT = 8000;

export interface ApifyOptions {
  /** Platform Apify token (usage charged to the organization's credit at the "apify.usage" price). */
  platformToken?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  enqueue?: (runId: string) => Promise<void>;
  pollMs?: number;
  allowPrivateEndpoints?: boolean;
}

type Actor = typeof apifyActors.$inferSelect;

/** Checks input against the allowlisted Actor's contract; unknown fields are rejected. */
export async function validateActorInput(fields: Record<string, ActorField>, input: Record<string, unknown>, allowPrivate = false): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) if (!(k in fields)) throw new AppError("VALIDATION", `“${k}” isn't an allowed input for this Actor.`);
  for (const [k, f] of Object.entries(fields)) {
    let v = input[k];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
      if (f.required) throw new AppError("VALIDATION", `Enter ${f.description ?? k}.`);
      continue;
    }
    if (f.type === "number") {
      v = Number(v);
      if (!Number.isFinite(v as number) || (v as number) < 0 || (f.max !== undefined && (v as number) > f.max)) throw new AppError("VALIDATION", `${k} must be between 0 and ${f.max ?? "∞"}.`);
    } else if (f.type === "boolean") v = v === true || v === "true" || v === "on";
    else if (f.type === "string") {
      v = String(v).trim();
      if ((v as string).length > (f.max ?? 2000)) throw new AppError("VALIDATION", `${k} is too long.`);
    } else {
      const list = (Array.isArray(v) ? v : String(v).split(/\n|,/)).map((x) => String(x).trim()).filter(Boolean);
      if (list.length > (f.max ?? 20)) throw new AppError("VALIDATION", `At most ${f.max ?? 20} entries for ${k}.`);
      if (f.type === "url[]") {
        for (const u of list) await assertSafeOutboundUrl(u, { allowPrivate, requireHttps: false });
        v = list.map((url) => ({ url }));
      } else v = list;
    }
    out[k] = v;
  }
  return out;
}

/** Normalises Actor output into a small, predictable shape (text is capped). */
export function normalizeItems(kind: string, items: unknown[], max: number): Record<string, unknown>[] {
  const s = (v: unknown, n = 500) => (v == null ? "" : String(v).slice(0, n));
  const out: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (out.length >= max) break;
    const it = (raw ?? {}) as Record<string, unknown>;
    if (kind === "web_pages") out.push({ url: s(it.url, 2000), title: s((it.metadata as { title?: string } | undefined)?.title ?? it.title), text: s(it.text ?? it.markdown, MAX_TEXT) });
    else if (kind === "search_results") {
      const organic = Array.isArray(it.organicResults) ? (it.organicResults as Record<string, unknown>[]) : [it];
      for (const r of organic) if (out.length < max && r.url) out.push({ url: s(r.url, 2000), title: s(r.title), snippet: s(r.description ?? r.snippet, 1000), query: s((it.searchQuery as { term?: string } | undefined)?.term ?? it.query) });
    } else out.push(Object.fromEntries(Object.entries(it).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)).slice(0, 20).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 2000) : v])));
  }
  return out;
}

/**
 * Apify (§17) through its official API v2. Only allowlisted Actors run, with
 * validated input, item and time limits and a maximum charge. With the
 * organization's own token, Apify bills them directly; with the platform
 * token, usage is charged to credit at the "apify.usage" price, metered
 * separately from AI.
 */
export class ApifyService {
  private readonly ledger: LedgerService;
  constructor(
    private readonly db: Database,
    private readonly opts: ApifyOptions = {},
  ) {
    this.ledger = new LedgerService(db);
  }

  private get base() {
    return (this.opts.baseUrl ?? "https://api.apify.com").replace(/\/$/, "");
  }
  private async api(token: string, path: string, init: RequestInit = {}) {
    const res = await (this.opts.fetch ?? fetch)(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new AppError("VALIDATION", `Apify returned ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async actors() {
    return this.db.select().from(apifyActors).where(eq(apifyActors.enabled, true));
  }

  async connection(organizationId: string) {
    const [c] = await this.db.select({ tokenHint: apifyConnections.tokenHint, createdAt: apifyConnections.createdAt }).from(apifyConnections).where(eq(apifyConnections.organizationId, organizationId));
    return c ?? null;
  }

  async connect(actorUserId: string, organizationId: string, token: string) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.settings.manage");
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token.trim())) throw new AppError("VALIDATION", "That doesn't look like an Apify API token.");
    const t = token.trim();
    await this.db.insert(apifyConnections).values({ organizationId, encryptedToken: encryptSecret(t, AAD(organizationId)), tokenHint: `…${t.slice(-4)}`, createdByUserId: actorUserId }).onConflictDoUpdate({ target: apifyConnections.organizationId, set: { encryptedToken: encryptSecret(t, AAD(organizationId)), tokenHint: `…${t.slice(-4)}`, createdByUserId: actorUserId, createdAt: new Date() } });
    await recordAudit(this.db, { organizationId, actorUserId, action: "apify.connected", targetType: "organization", targetId: organizationId });
  }

  async disconnect(actorUserId: string, organizationId: string) {
    await requireOrgPermission(this.db, actorUserId, organizationId, "org.settings.manage");
    await this.db.delete(apifyConnections).where(eq(apifyConnections.organizationId, organizationId));
  }

  /** How a run would be paid for, or why it can't run. */
  async funding(organizationId: string): Promise<{ funding: "byok" | "platform"; token: string; marginBps?: number; pricingVersionId?: string } | { error: string }> {
    const [c] = await this.db.select().from(apifyConnections).where(eq(apifyConnections.organizationId, organizationId));
    if (c) return { funding: "byok", token: decryptSecret(c.encryptedToken, AAD(organizationId)) };
    if (!this.opts.platformToken) return { error: "Connect your organization's Apify account (Settings → Integrations) to run Actors." };
    const price = await this.ledger.servicePrice("apify.usage");
    if (!price) return { error: "Platform Apify usage isn't priced yet. Connect your own Apify account instead." };
    return { funding: "platform", token: this.opts.platformToken, marginBps: price.marginBps, pricingVersionId: price.pricingVersionId };
  }

  async start(actorUserId: string, projectId: string, actorKey: string, input: Record<string, unknown>) {
    const access = await getProjectAccess(this.db, actorUserId, projectId);
    if (!access.permissions.has("project.update")) throw new AppError("FORBIDDEN", "You need edit access to the project.");
    const ent = await getEntitlements(this.db, access.organizationId);
    if (!featureEnabled(ent, "integrations.apify")) throw new AppError("FEATURE_NOT_ENTITLED", `Apify is not included in the ${ent.planName} plan.`, { feature: "integrations.apify" });
    const [actor] = await this.db.select().from(apifyActors).where(and(eq(apifyActors.key, actorKey), eq(apifyActors.enabled, true)));
    if (!actor) throw new AppError("VALIDATION", "That Actor isn't approved.");
    const clean = await validateActorInput(actor.inputFields, input, this.opts.allowPrivateEndpoints);
    const f = await this.funding(access.organizationId);
    if ("error" in f) throw new AppError("VALIDATION", f.error);
    const estimate = f.funding === "platform" ? customerPrice(actor.maxChargeMicros, f.marginBps!) : null;
    const run = await this.db.transaction(async (tx) => {
      if (estimate) await this.ledger.checkBudget(access.organizationId, estimate, tx);
      const [row] = await tx.insert(apifyRuns).values({ organizationId: access.organizationId, projectId, userId: actorUserId, actorKey, input: clean, funding: f.funding, estimatedChargeMicros: estimate }).returning();
      return row!;
    });
    await recordAudit(this.db, { organizationId: access.organizationId, actorUserId, action: "apify.run.queued", targetType: "apify_run", targetId: run.id, metadata: { actor: actor.actorId, funding: f.funding } });
    await this.opts.enqueue?.(run.id);
    return run;
  }

  /** Worker: starts the Actor, waits (bounded), fetches and normalises results, meters cost. */
  async process(runId: string) {
    const [run] = await this.db.select().from(apifyRuns).where(eq(apifyRuns.id, runId));
    if (!run || run.status !== "queued") return;
    const [actor] = await this.db.select().from(apifyActors).where(eq(apifyActors.key, run.actorKey));
    const fail = async (status: "failed" | "aborted" | "timed_out", error: string, extra: Partial<typeof apifyRuns.$inferInsert> = {}) => {
      await this.db.update(apifyRuns).set({ status, error: error.slice(0, 500), finishedAt: new Date(), ...extra }).where(eq(apifyRuns.id, runId));
    };
    if (!actor?.enabled) return fail("failed", "This Actor is no longer approved.");
    const f = await this.funding(run.organizationId);
    if ("error" in f) return fail("failed", f.error);
    await this.db.update(apifyRuns).set({ status: "running", startedAt: new Date() }).where(eq(apifyRuns.id, runId));
    let apifyRunId: string | null = null;
    try {
      const q = new URLSearchParams({ timeout: String(actor.timeoutSecs), memory: String(actor.memoryMbytes), maxItems: String(actor.maxItems), maxTotalChargeUsd: (actor.maxChargeMicros / 1e6).toFixed(2) });
      const started = await this.api(f.token, `/v2/acts/${encodeURIComponent(actor.actorId.replace("/", "~"))}/runs?${q}`, { method: "POST", body: JSON.stringify({ ...run.input, ...actor.fixedInput }) });
      apifyRunId = String(started.data?.id);
      await this.db.update(apifyRuns).set({ apifyRunId, datasetId: started.data?.defaultDatasetId ?? null }).where(eq(apifyRuns.id, runId));
      const deadline = Date.now() + (actor.timeoutSecs + 60) * 1000;
      let info = started.data as { status: string; defaultDatasetId?: string; usageTotalUsd?: number };
      while (!TERMINAL.has(info.status)) {
        if (Date.now() > deadline) {
          await this.api(f.token, `/v2/actor-runs/${apifyRunId}/abort`, { method: "POST" }).catch(() => {});
          return fail("timed_out", "The Actor took too long and was stopped.");
        }
        await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 3000));
        info = (await this.api(f.token, `/v2/actor-runs/${apifyRunId}`)).data;
      }
      const costMicros = Math.round(Number(info.usageTotalUsd ?? 0) * 1e6);
      let items: unknown[] = [];
      if (info.status === "SUCCEEDED" && info.defaultDatasetId) items = await this.api(f.token, `/v2/datasets/${info.defaultDatasetId}/items?clean=true&format=json&limit=${actor.maxItems}`);
      const results = normalizeItems(actor.normalizer, Array.isArray(items) ? items : [], actor.maxItems);
      await this.db.transaction(async (tx) => {
        let charge = 0;
        if (costMicros > 0) {
          const rec = await this.ledger.meterService(tx, { organizationId: run.organizationId, projectId: run.projectId, userId: run.userId, serviceKey: "apify.usage", quantity: costMicros, unit: "usd_micro", sourceType: "apify_run", sourceId: run.id, funding: f.funding });
          charge = rec?.customerChargeMicros ?? 0;
        }
        const status = info.status === "SUCCEEDED" ? "succeeded" : info.status === "ABORTED" ? "aborted" : info.status === "TIMED-OUT" ? "timed_out" : "failed";
        await tx.update(apifyRuns).set({ status, itemCount: results.length, results, costMicros, chargeMicros: charge, error: status === "succeeded" ? null : `Apify reported ${info.status}.`, finishedAt: new Date() }).where(eq(apifyRuns.id, runId));
      });
    } catch (err) {
      logger.warn("apify.run_failed", { runId, error: String(err) });
      if (apifyRunId) await this.api(f.token, `/v2/actor-runs/${apifyRunId}/abort`, { method: "POST" }).catch(() => {});
      await fail("failed", String((err as Error).message ?? err));
    }
  }

  async list(actorUserId: string, projectId: string) {
    await getProjectAccess(this.db, actorUserId, projectId);
    return this.db.select().from(apifyRuns).where(eq(apifyRuns.projectId, projectId)).orderBy(desc(apifyRuns.createdAt)).limit(30);
  }

  async get(actorUserId: string, runId: string) {
    const [r] = await this.db.select().from(apifyRuns).where(eq(apifyRuns.id, runId));
    if (!r) throw new AppError("NOT_FOUND", "Run not found.");
    await getProjectAccess(this.db, actorUserId, r.projectId);
    return r;
  }
}
