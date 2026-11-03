"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { toolkitAction } from "@/server/actions/toolkit";

interface Col {
  name: string;
  label: string;
  type: string;
}

const KINDS: { key: string; label: string; advanced: boolean }[] = [
  { key: "descriptives", label: "Descriptive statistics", advanced: false },
  { key: "frequencies", label: "Frequency table", advanced: false },
  { key: "crosstab", label: "Cross-tabulation (χ²)", advanced: false },
  { key: "missing", label: "Missing values", advanced: false },
  { key: "correlation", label: "Correlation", advanced: true },
  { key: "ttest", label: "Two-group t-test (Welch)", advanced: true },
  { key: "anova", label: "One-way ANOVA", advanced: true },
  { key: "regression", label: "Linear regression (OLS)", advanced: true },
];

function Pick({ id, name, label, cols, multiple }: { id: string; name: string; label: string; cols: Col[]; multiple?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} className="input" required multiple={multiple} size={multiple ? Math.min(6, Math.max(3, cols.length)) : undefined}>
        {cols.map((c) => (
          <option key={c.name} value={c.name}>{c.label === c.name ? c.name : `${c.label} (${c.name})`}</option>
        ))}
      </select>
    </div>
  );
}

export function AnalysisForm({ projectId, datasetId, columns, advanced }: { projectId: string; datasetId: string; columns: Col[]; advanced: boolean }) {
  const [kind, setKind] = useState("descriptives");
  const numeric = columns.filter((c) => c.type === "numeric");
  const grouping = columns.filter((c) => c.type !== "text");
  return (
    <ActionForm action={toolkitAction} submitLabel="Run and save" pendingLabel="Running…" className="grid max-w-2xl gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="datasetId" value={datasetId} />
      <input type="hidden" name="intent" value="analyse" />
      <div className="field">
        <label htmlFor="an-kind">Analysis</label>
        <select id="an-kind" name="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k.key} value={k.key} disabled={k.advanced && !advanced}>
              {k.label}
              {k.advanced && !advanced ? " — higher plan" : ""}
            </option>
          ))}
        </select>
      </div>
      {kind === "descriptives" && <Pick id="an-vars" name="variables" label="Numeric variables (select one or more)" cols={numeric} multiple />}
      {kind === "frequencies" && <Pick id="an-var" name="variable" label="Variable" cols={columns} />}
      {kind === "crosstab" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick id="an-row" name="row" label="Rows" cols={grouping} />
          <Pick id="an-col" name="column" label="Columns" cols={grouping} />
        </div>
      )}
      {kind === "correlation" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Pick id="an-x" name="x" label="Variable X" cols={numeric} />
          <Pick id="an-y" name="y" label="Variable Y" cols={numeric} />
          <div className="field">
            <label htmlFor="an-method">Method</label>
            <select id="an-method" name="method" className="input">
              <option value="pearson">Pearson</option>
              <option value="spearman">Spearman (rank)</option>
            </select>
          </div>
        </div>
      )}
      {(kind === "ttest" || kind === "anova") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick id="an-out" name="outcome" label="Outcome (numeric)" cols={numeric} />
          <Pick id="an-group" name="group" label={kind === "ttest" ? "Grouping variable (two groups)" : "Grouping variable"} cols={grouping} />
        </div>
      )}
      {kind === "regression" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick id="an-out" name="outcome" label="Outcome (numeric)" cols={numeric} />
          <Pick id="an-preds" name="predictors" label="Predictors (categorical ones are dummy-coded)" cols={columns.filter((c) => c.type !== "text")} multiple />
        </div>
      )}
      <div className="field">
        <label htmlFor="an-notes">Notes (optional)</label>
        <input id="an-notes" name="notes" className="input" maxLength={2000} placeholder="e.g. Hypothesis H1" />
      </div>
    </ActionForm>
  );
}
