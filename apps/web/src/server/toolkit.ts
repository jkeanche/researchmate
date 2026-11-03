import { getEntitlements, tierOf } from "@researchmate/entitlements";
import { cache } from "react";
import { loadProject } from "./plan";
import { db } from "./services";

/** Project + toolkit tier for the toolkit pages (the service re-checks every write). */
export const loadToolkit = cache(async (projectId: string) => {
  const p = await loadProject(projectId);
  const ent = await getEntitlements(db(), p.project.organizationId);
  const tier = tierOf(ent, "toolkit");
  const editable = p.can("project.update") && !p.archived;
  return { ...p, planName: ent.planName, tier, basic: tier !== "none", advanced: tier === "advanced", canEdit: tier !== "none" && editable };
});

export const ANALYSIS_LABELS: Record<string, string> = {
  missing: "Missing values",
  descriptives: "Descriptive statistics",
  frequencies: "Frequency table",
  crosstab: "Cross-tabulation (χ²)",
  correlation: "Correlation",
  regression: "Linear regression",
  ttest: "Two-group t-test",
  anova: "One-way ANOVA",
};
export const ADVANCED_ANALYSES = new Set(["correlation", "regression", "ttest", "anova"]);
