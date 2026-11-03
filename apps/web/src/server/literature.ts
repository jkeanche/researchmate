import { getEntitlements, tierOf } from "@researchmate/entitlements";
import type { ScholarlyRecord } from "@researchmate/literature";
import { AppError, hmacHex, safeEqual } from "@researchmate/shared";
import { cache } from "react";
import { loadProject } from "./plan";
import { db } from "./services";

/** Project + literature entitlements for the literature pages. */
export const loadLiterature = cache(async (projectId: string) => {
  const p = await loadProject(projectId);
  const ent = await getEntitlements(db(), p.project.organizationId);
  const toolkit = tierOf(ent, "toolkit") !== "none";
  const web = tierOf(ent, "research.web") !== "none";
  return { ...p, planName: ent.planName, toolkit, web, canEdit: toolkit && p.can("project.update") && !p.archived };
});

/**
 * Search results are rendered into "Add" forms. The record is signed so the
 * library only records provider provenance ("metadata retrieved from
 * Crossref") for data that really came back from the provider.
 */
export function signRecord(projectId: string, r: ScholarlyRecord): { record: string; sig: string } {
  const record = JSON.stringify(r);
  return { record, sig: hmacHex(`scholarly:${projectId}:${record}`) };
}

export function verifyRecord(projectId: string, record: string, sig: string): ScholarlyRecord {
  if (!sig || !safeEqual(hmacHex(`scholarly:${projectId}:${record}`), sig)) throw new AppError("VALIDATION", "That search result could not be verified. Search again and add it from the results.");
  const r = JSON.parse(record) as ScholarlyRecord;
  if (Date.now() - Date.parse(r.retrievedAt) > 24 * 3600 * 1000) throw new AppError("VALIDATION", "That search result is more than a day old. Search again.");
  return r;
}

export const VERIFICATION_LABELS: Record<string, string> = {
  unverified: "Unverified",
  metadata_retrieved: "Metadata retrieved",
  metadata_verified: "Metadata verified",
  full_text_retrieved: "Full text attached",
  full_text_reviewed: "Full text reviewed",
  verification_failed: "Verification failed",
};
export const VERIFICATION_TONE: Record<string, string> = {
  unverified: "awaiting_approval",
  metadata_retrieved: "todo",
  metadata_verified: "in_progress",
  full_text_retrieved: "in_progress",
  full_text_reviewed: "done",
  verification_failed: "blocked",
};
export const ACCESS_LABELS: Record<string, string> = { metadata: "Bibliographic details only", abstract: "Abstract", full_text: "Full text" };
