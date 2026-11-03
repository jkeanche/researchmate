import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { PLAN_SEEDS } from "./catalog/features";
import { BUDGET_CATEGORY_SEEDS, PERMISSIONS, ROLE_SEEDS } from "./catalog/rbac";
import { WORKFLOW_TEMPLATE_SEEDS } from "./catalog/workflows";
import { DOCUMENT_TEMPLATE_SEEDS } from "./catalog/documents";
import { apifyActors, budgetCategories, documentTemplates, pricePoints, permissions, planEntitlements, plans, rolePermissions, roles, workflowStages, workflowTemplates } from "./schema";

/**
 * Idempotent reference-data seed: permissions, roles, role grants and plans.
 *
 * Role/permission grants are synchronised to the catalogue. Plans are inserted
 * if missing; existing plan prices and entitlement values are NOT overwritten,
 * so administrators can tune them in the database. Missing entitlement keys
 * are added with seed defaults. System workflow templates are inserted per
 * (key, version) and never modified once present.
 */
export async function seedReferenceData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [key, p] of Object.entries(PERMISSIONS)) {
      await tx
        .insert(permissions)
        .values({ key, description: p.description, domain: p.domain })
        .onConflictDoUpdate({ target: permissions.key, set: { description: p.description, domain: p.domain } });
    }

    for (const r of ROLE_SEEDS) {
      await tx
        .insert(roles)
        .values({ key: r.key, name: r.name, description: r.description, scope: r.scope, rank: r.rank })
        .onConflictDoUpdate({
          target: roles.key,
          set: { name: r.name, description: r.description, scope: r.scope, rank: r.rank },
        });
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleKey, r.key));
      if (r.permissions.length) {
        await tx.insert(rolePermissions).values([...new Set(r.permissions)].map((p) => ({ roleKey: r.key, permissionKey: p })));
      }
    }

    for (const p of PLAN_SEEDS) {
      const [row] = await tx
        .insert(plans)
        .values({
          key: p.key,
          name: p.name,
          description: p.description,
          priceMinor: p.priceMinor,
          sortOrder: p.sortOrder,
          isDefault: p.isDefault ?? false,
        })
        .onConflictDoUpdate({ target: plans.key, set: { updatedAt: sql`${plans.updatedAt}` } })
        .returning({ id: plans.id });
      if (!row) throw new Error(`Failed to upsert plan ${p.key}`);
      for (const [featureKey, value] of Object.entries(p.entitlements)) {
        await tx.insert(planEntitlements).values({ planId: row.id, featureKey, value }).onConflictDoNothing();
      }
    }

    for (const w of WORKFLOW_TEMPLATE_SEEDS) {
      const [existing] = await tx
        .select({ id: workflowTemplates.id })
        .from(workflowTemplates)
        .where(and(isNull(workflowTemplates.organizationId), eq(workflowTemplates.key, w.key), eq(workflowTemplates.version, w.version)));
      if (existing) continue;
      const [tpl] = await tx
        .insert(workflowTemplates)
        .values({ key: w.key, version: w.version, name: w.name, description: w.description, defaultFor: w.defaultFor })
        .returning({ id: workflowTemplates.id });
      // Older versions of the same template stop being offered for new projects.
      await tx
        .update(workflowTemplates)
        .set({ isActive: false })
        .where(and(isNull(workflowTemplates.organizationId), eq(workflowTemplates.key, w.key), sql`${workflowTemplates.version} < ${w.version}`));
      await tx.insert(workflowStages).values(
        w.stages.map((st, i) => ({
          templateId: tpl!.id,
          key: st.key,
          name: st.name,
          purpose: st.purpose,
          expectedOutputs: st.expectedOutputs,
          completionCriteria: st.completionCriteria,
          durationDays: st.durationDays,
          dependsOn: (st.dependsOn ?? []).map((d) => (typeof d === "string" ? { key: d, type: "FS" as const, lagDays: 0 } : { key: d.key, type: d.type, lagDays: d.lagDays ?? 0 })),
          approvalRequired: st.approvalRequired ?? false,
          optional: st.optional ?? false,
          milestoneName: st.milestone ?? null,
          sortOrder: i,
        })),
      );
    }

    for (const d of DOCUMENT_TEMPLATE_SEEDS) {
      const inserted = await tx
        .insert(documentTemplates)
        .values({ key: d.key, version: d.version, name: d.name, documentType: d.documentType, description: d.description, spec: d.spec as unknown as Record<string, unknown> })
        .onConflictDoNothing()
        .returning({ id: documentTemplates.id });
      if (inserted.length) await tx.update(documentTemplates).set({ active: false }).where(and(eq(documentTemplates.key, d.key), sql`${documentTemplates.version} < ${d.version}`));
    }

    // Starting catalogue in USD, only when none exists. Other currencies (e.g. KES for
    // M-PESA) are added by administrators with their own prices; nothing is converted.
    const [{ n: pp }] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from price_points`)) as unknown as [{ n: number }];
    if (Number(pp) === 0) {
      const paid = await tx.select().from(plans).where(sql`${plans.priceMinor} > 0 and ${plans.isActive}`);
      for (const p of paid) await tx.insert(pricePoints).values({ kind: "plan", planId: p.id, interval: p.billingInterval, currency: p.currency, amountMinor: p.priceMinor, label: `${p.name} (${p.billingInterval}ly)` });
      for (const usd of [10, 25, 50]) await tx.insert(pricePoints).values({ kind: "credits", creditMicros: usd * 1_000_000, currency: "USD", amountMinor: usd * 100, label: `US$${usd} AI credit` });
    }

    // Apify allowlist candidates, disabled until a platform administrator checks the
    // Actors' current input schema and pricing and enables them.
    await tx
      .insert(apifyActors)
      .values([
        { key: "website_content_crawler", actorId: "apify/website-content-crawler", name: "Website content crawler", description: "Crawls pages from start URLs and returns their text.", inputFields: { startUrls: { type: "url[]", required: true, max: 5, description: "start URLs" }, maxCrawlPages: { type: "number", max: 50, description: "maximum pages" } }, fixedInput: { crawlerType: "cheerio" }, maxItems: 50, timeoutSecs: 600, memoryMbytes: 2048, maxChargeMicros: 2_000_000, normalizer: "web_pages", enabled: false, notes: "Verify input fields against the Actor's README before enabling." },
        { key: "google_search", actorId: "apify/google-search-scraper", name: "Google Search results", description: "Returns organic search results for queries.", inputFields: { queries: { type: "string", required: true, max: 500, description: "search queries (one per line)" }, maxPagesPerQuery: { type: "number", max: 3 } }, fixedInput: {}, maxItems: 100, timeoutSecs: 300, memoryMbytes: 1024, maxChargeMicros: 1_000_000, normalizer: "search_results", enabled: false, notes: "Verify input fields against the Actor's README before enabling." },
      ])
      .onConflictDoNothing();

    for (const [i, c] of BUDGET_CATEGORY_SEEDS.entries()) {
      const [existing] = await tx.select({ id: budgetCategories.id }).from(budgetCategories).where(and(isNull(budgetCategories.organizationId), eq(budgetCategories.key, c.key)));
      if (existing) await tx.update(budgetCategories).set({ name: c.name, sortOrder: i }).where(eq(budgetCategories.id, existing.id));
      else await tx.insert(budgetCategories).values({ key: c.key, name: c.name, sortOrder: i });
    }
  });
}
