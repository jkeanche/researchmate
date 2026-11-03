# Milestone 10 report: research toolkit

Date: 2 November 2026 · Blueprint phase 15 (§10.2–10.5, §10.9, §10.11)

## What was built

A **Toolkit** tab in every project, with five sections: data and analysis, diagrams, questionnaires, sample size, and presentations and reports. Toolkit features are gated by the existing `toolkit` tier:
- **Free** (none): read-only.
- **Starter** (basic): datasets, cleaning, descriptive analyses, diagrams, questionnaires and the calculators.
- **Pro and Team** (advanced): adds inferential statistics and generated presentations and reports.

Every write goes through `ToolkitService`, which checks project membership, edit rights, archive state and tier on the server.

**Datasets and statistics (§10.3).**
- **Import:** CSV (BOM-safe) or XLSX (choice of worksheet) from a project file.
  - The first row holds the variable names; duplicate names get suffixes.
  - `NA`, `n/a` and blank cells are treated as missing; thousands separators are understood.
  - Limits: up to 100,000 rows, 200 columns and 20 MB.
- **Stored copy:** the dataset is stored with its source file and version, so analyses are reproducible.
- **Variables:** types (numeric, categorical or text) are inferred, with labels and missing counts.
- **Cleaning:** mark codes such as `-99` as missing, or change a variable's type.
  - Each change is recorded as an ordered, timestamped **cleaning step** shown on the page.
  - The cleaned data downloads as CSV, with cells that start like formulas neutralised.
- **Analyses:**
  - missing values, descriptives (n, mean, SD, SE, quartiles of type 7), frequencies with a bar chart, and cross-tabulation with χ², Cramér's V and a warning when expected counts are below 5;
  - Pearson and Spearman correlation, Welch's two-group t-test with a 95% CI and Cohen's d, one-way ANOVA with η², and OLS regression with dummy-coded categorical predictors, SEs, t, p, CIs, R², adjusted R² and the F test.
- **Deterministic results:** all calculations are done in code (jStat only for distribution functions), never by an LLM.
- **Saved with each analysis:** its specification, a **plain-language method and assumptions** text, the result and optional notes.
- **Missing values:** rows missing a chosen variable are dropped listwise, and the page says so.

**Diagrams (§10.2).**
- **Templates:** conceptual framework, methodology flowchart, theory of change, ER model, mind map, logic model, decision tree and organisational chart.
- **Editing:** the Mermaid source is editable, with a live preview.
- **Mermaid 11.17.2** renders the diagrams in the browser with `securityLevel: "strict"`. Its output is sanitised, and click and script directives do nothing.
  - The server also rejects `init` directives that try to change the security level.
  - Labels are drawn as SVG text, so PNG export doesn't taint the canvas.
- **Export:** SVG, PNG (2×), and PDF via a print stylesheet.
- **Saving:** saves use an optimistic revision number, so two people editing at once can't silently overwrite each other.

**Questionnaires (§10.4).**
- **Question types:** single choice, multiple choice, Likert (5- and 7-point agreement, frequency and satisfaction templates, or custom anchors), open text and number. Each question has an editable variable name, a required flag and an optional section.
- **Text:** an introduction and a consent statement, prefilled with neutral wording and an on-page note to check it against the ethics approval. Nothing claims approval.
- **Validation:**
  - variable names must be valid and unique;
  - choice questions need at least two options;
  - a questionnaire has at most 300 questions;
  - saves use optimistic revisions.
- **Exports:**
  - a printable **Word questionnaire** with tick boxes, Likert grids and answer lines;
  - an **Excel codebook** with one row per answer variable (multiple choice is split into 0/1 columns) and the codes;
  - a blank **data-entry sheet** whose columns match the codebook.
- **Responses:** they are collected outside ResearchMate. The filled data-entry sheet can be imported back as a dataset for frequencies and cross-tabs.

**Sample size (§10.5).**
- **Two calculators:**
  - estimating a proportion, using Cochran's formula with an optional finite-population correction;
  - comparing two means, using a two-sided z approximation.
- Each result shows the **formula and its assumptions**: the design effect, non-response, where σ should come from, and that a t-test needs slightly more participants.

**Presentations and reports (§10.9).**
- **Editable PowerPoint decks** (pptxgenjs, 16:9): proposal, progress update and defense.
- **Word status report:** summary, stages, milestones, overdue tasks, next steps, open risks and supervisor reviews.
- Both are built only from what is recorded in the project. A section with nothing recorded gets a placeholder ("No objectives recorded yet — add them on the Plan tab"). The defense deck's findings slides are left for the researcher to fill in, not generated.
- **Visual check:** sample decks and the report were rendered through LibreOffice and inspected, with no overflow or clipping.

## Data

Migration `0009_toolkit`:
- `datasets`: columns and rows as JSONB, a row-count check and cleaning steps;
- `analyses`: kind check, method, result;
- `diagrams`: source size check, revision;
- `surveys`: questions JSONB, revision.

All of them cascade from the project. No new queue: every toolkit operation is synchronous and bounded by the limits above.

## Tests

`tests/toolkit.test.ts` (13 tests):
- **Statistics checked against SciPy/NumPy** on a fixed 16-row dataset:
  - descriptives, Pearson and Spearman correlation, Welch t, ANOVA F and p, χ² with df and p, and OLS coefficients, SEs and R²;
  - agreement to about 1e-6 or better (p-values down to 1e-13 included).
- **Import:** CSV and XLSX, BOM, `NA` cells, duplicate headers, missing-code cleaning, and re-sending an unchanged type adds no cleaning step.
- **Refused:** a non-tabular file, a file from another project, unknown variables or analyses, and a t-test without two usable groups.
- **Plan gating:** Free gets nothing; Starter gets basic tools but not correlation or regression.
- **Tenancy:** an outsider can't read or analyse a dataset.
- **Diagrams:** templates, revision conflicts, and the security-directive check.
- **Questionnaires:** validation, duplicate ids, revision conflicts, codebook variables, formula neutralisation in the XLSX, and the DOCX text.
- **Outputs:** decks (three kinds) and a status report generated from a project with no data.
- **Sample size:** Cochran (385, and 278 with N = 1,000) and two means (63 per group for d = 0.5, α = .05, power .8).

`tests/e2e/toolkit.spec.ts` covers the whole path in a browser:
- upload a CSV, import it and mark `-99` as missing;
- descriptives (checked numbers) and a regression with a categorical predictor, n and the method text;
- create a diagram, edit it, render it with Mermaid, save it and download the SVG;
- a `click … call alert()` directive produces no handler;
- build a questionnaire with Likert and choice items and download the codebook;
- the sample-size result (278) with its formula;
- download the progress deck.

**Totals:** 190 unit/integration tests and 11 E2E tests passing; typecheck clean; production build succeeds.

## Bug found and fixed during testing

The variable edit form always sends the type, so an unchanged "numeric" was recorded as a cleaning step. Only real type changes are recorded now, and there is a regression test.

The questionnaire editor was keyed by revision, so a save that revalidated the page remounted the editor and lost its "Saved." state. The editor already tracks the revision itself, so the key was removed.

## Not built in this milestone (recorded in spec-review)

- **Qualitative coding and thematic analysis (§10.3):** literature evidence already has themes, but there is no coding of interview transcripts yet.
- **Statistical charts beyond the frequency bar chart:** no histograms or scatter plots yet.
- **Methodology tools (§10.5):**
  - design comparison;
  - operationalisation and alignment matrices (objectives and questions already exist on the Plan tab);
  - validity and ethics checklists.
- **Reporting outputs (§10.9):** posters, supervisor-meeting reports and executive summaries.
- **Questionnaires (§10.4):** public links and response collection, so there are no response summaries or collection status.
- **Usage limits per toolkit tool (§10.11):** the dataset size caps and the plan tier are the limits for now.
