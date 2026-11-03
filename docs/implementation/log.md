# Implementation log

Newest first. One entry per working session.

## 2026-11-02 — Milestone 11 (production hardening)

- Notifications (§30): in-app + email with preferences (security alerts locked on), dedupe, SKIP LOCKED email delivery; wired to deadlines, reviews, exports, storage/AI/budget thresholds, expenses, funding, billing, Drive, and security events incl. new-device sign-in.
- Search (§31): permission-scoped full-text search across 13 record types, per project and workspace-wide.
- Security: optional ClamAV scanning (fail closed); workspace deletion with 30-day restore and purge that retains financial records; account deletion by pseudonymisation; dependency audit 27 → 2 known findings; duplicate security emails removed.
- Monitoring: worker heartbeat, token-protected Prometheus metrics, Prometheus profile with alert rules. Backups: GPG/rclone options, verify-backup.sh (restore into a scratch DB). Performance: 54 FK indexes + guard tests. Deployment: worker/scheduler roles, worker HEALTHCHECK, §35 env aliases, guide updated.
- Fixed: shared Drizzle builder in the deadline scan; redirect loop for users without a workspace; E2E harness leaking child processes; suite exceeding the per-IP sign-up limit (fixture resets counters).
- Final: 208 unit/integration and 15 E2E tests passing; typecheck clean; production build succeeds. Images not built here (Docker Hub not reachable).

## 2026-11-02 — Milestone 10 (research toolkit)

- `@researchmate/toolkit`: dataset import (CSV/XLSX), variable metadata and recorded cleaning steps; deterministic statistics (descriptives, frequencies, χ² crosstab, Pearson/Spearman, Welch t, ANOVA, OLS) checked against SciPy; each analysis stored with its method and assumptions.
- Mermaid diagrams (8 templates, strict security, SVG/PNG/print export, optimistic revisions); questionnaire builder with Word and codebook/data-entry XLSX exports; sample-size calculators with formulas; PPTX decks and a DOCX status report from recorded project data only.
- Tier gating: basic vs advanced. Migration `0009_toolkit`. Fixed: spurious cleaning step for unchanged types; editor remount losing save state.
- Final: 190 unit/integration and 11 E2E tests passing.

## 2026-11-02 — Milestone 9 (integrations)

- MCP registry with discovery, approval, guarded transport, argument checks, limits and append-only audit; approved tools offered to the assistant as untrusted data.
- Apify via API v2 with an Actor allowlist, input contracts, limits, BYOK or platform billing separate from AI.
- Approved-website capture with per-hop checks and dated snapshots. Migration `0008_integrations`, `integrations` queue.
- Final: 177 unit/integration and 10 E2E tests passing.

## 2026-11-02 — Milestone 8 (AI billing and payments)

- Researched payment providers for Kenya (Stripe only via Paystack's "extended network"; Paystack and Pesapal direct; Paddle seller eligibility unconfirmed). Evaluation in `docs/architecture/payments.md`.
- Package `@researchmate/billing`: pricing versions, ledger with allowance and credit pools, spending limits, budget checks, service metering, Paystack/Pesapal/Stripe adapters, payments, invoices, refunds, prepaid subscription periods and renewals. Migration `0007_billing`.
- Platform-funded AI in the AI service with explicit funding, two-stage budget checks, an output cap and charges from immutable pricing.
- Found a webhook robustness gap through E2E (duplicates didn't settle interrupted payments); fixed. Removed an unverifiable tax statement from invoices.
- Final: 172 unit/integration and 10 E2E tests passing.

## 2026-11-02 — Milestone 7 (supervisor collaboration)

- Package `@researchmate/collaboration`: invitations, supervisor assignments, review requests, feedback, revision tasks, time measures. Migration `0006_collaboration`.
- Supervisor Feedback Agent (suggestions only). Web: invitation page, Team-tab invitations and supervisors, Reviews tab and review page, dashboard invitations and review inbox.
- Found an intermittent PDF failure from M6: a LibreOffice child process still writing during cleanup. Fixed with process-group kill, wait and non-fatal cleanup; verified under stress.
- Final: 164 unit/integration and 9 E2E tests passing.

## 2026-11-02 — Milestone 6 (document engine)

- Package `@researchmate/documents`: markup parser, model assembly (numbering, citations, word counts), DOCX writer, LibreOffice/UNO PDF rendering, PDF inspection, validation, service.
- Migration `0005_documents`: 10 tables, with append-only triggers on specification and content versions. Eight templates seeded per (key, version).
- `documents` queue in the worker. Web: Documents tab with editor, preview, checks and audit, versions and export, specification.
- The output validator found a real defect (images clipped by line spacing in LibreOffice); fixed in the DOCX styles.
- Also fixed: an empty contents page (outline levels), empty optional sections being printed, and switching sections with unsaved text (now saved on the way out).
- Final: 158 unit/integration and 8 E2E tests passing.

## 2026-11-02 — Milestone 5 (literature and evidence)

- Packages `@researchmate/citations` (citeproc with six vendored CSL styles, BibTeX/RIS) and `@researchmate/literature` (scholarly clients for six providers, extraction with OCR, library, verification, evidence, matrix, passage search).
- Migration `0004_literature`; regenerated once before it was applied, to add two suggestion kinds.
- Two AI agents with code-level anti-fabrication checks: a verbatim quote match, and citation keys checked against the library.
- `files` queue: every stored version, including Drive imports, is extracted in the worker. The worker image gains poppler and Tesseract.
- Web: Literature tab with Library, Find sources, Evidence, Matrix and Search documents; the assistant page gains the two new agents.
- Found and fixed:
  - CSL lookup broke inside the Next bundle; added a fallback lookup and file tracing.
  - A test fixture used invalid DOIs.
  - pdf.js v6 API changes.
  - Passage search didn't check file permission; it now requires `project.files.read`.
  - The "Unverified" tag rendered struck through.
- Final: 149 unit/integration and 7 E2E tests passing.

## 2026-11-02 — Milestone 4 (Google Drive, AI foundation)

- Verified Mastra 1.76 APIs: docs plus type definitions, then a live probe against a local mock. Per-request keys and structured output confirmed.
- Packages `@researchmate/ai` (agents, BYOK, runs, metering, suggestions) and `@researchmate/integrations` (Drive), plus an SSRF guard in `shared`.
- Worker gained `ai` and `drive` queues. The web app gained OAuth routes, AI keys and Integrations settings, and a project AI assistant page.
- Probing showed the AI SDK's internal 5xx retries can't be disabled, so the queue no longer retries.
- E2E caught a premature `page.url()` in my test and an unmigrated dev database (both mine).
- Final: 137 unit/integration and 6 E2E tests passing.

## 2026-11-02 — Milestone 3 (optional finances)

- Finance schema and migration `0002_finance` with immutability and append-only triggers; integer minor units with BigInt conversion; 24 seeded categories.
- `@researchmate/finance`: service, pure `summarise()` aggregation, reports (exceljs 4.4.0, pdfkit 0.20.2).
- 12 integration tests passed on the first run.
- E2E and visual review found: expense success message hidden by a collapsing section; per-row action messages lost when the row's button disappears (tests now assert on history); report links had lowercase accessible names; duplicate element ids on five forms. All fixed.
- Final: 121 unit/integration and 5 E2E tests passing.

## 2026-11-02 — Milestone 2 (S3 storage, research management, planning)

- Re-verified the M1 baseline (56 tests) after a container restart; local Postgres now uses password auth for the dev user instead of `trust`.
- S3 driver with streaming multipart upload, byte cap and abort-on-error; tested against moto's S3 server (Docker Hub is not reachable from the build environment, so MinIO could not be pulled). Added `S3_FORCE_PATH_STYLE` and `S3_KEY_PREFIX`.
- Catalogue: three planning permissions, `planning.tasks.max` limit, four versioned workflow templates (thesis, article, proposal, report).
- Migration `0001_planning` (18 tables, project columns, baseline immutability triggers; existing projects switched to manual progress).
- Pure scheduling engine first, with 29 unit tests. One test expectation was wrong (start-to-finish semantics) and was corrected; the engine was right.
- Services: research content, project members, workflow stages with approval gates, planning service. Integration tests found a real bug: a new subtask's roll-up of its parent's dates wasn't saved (changes were compared against rolled-up instead of stored dates). Fixed.
- UI: project sub-navigation and nine project pages (overview dashboard, research, workflow, schedule/Gantt, tasks list/WBS/board, task detail, calendar, risks, time and workload, team).
- Visual review in a real browser found: completed tasks drew a forecast-slip outline; unlayered CSS overrode Tailwind utilities (invisible active tab label, full-width small inputs); ISO dates on board cards; a template milestone named like its stage. All fixed.
- E2E: new planning spec (proposal → approve → drag cascade → keyboard move → PNG export → baseline → history → loop refused → board status persists).
- Final: 109 unit/integration tests and 4 E2E tests passing; typecheck clean; production build succeeds.

## 2026-11-01 — Milestone 1 (foundation)

- Reviewed the blueprint; recorded gaps and decisions in `spec-review.md`.
- Inspected the workspace: empty, no existing repository. Initialised a pnpm monorepo.
- Chose versions: Next.js 16.4, React 19.3, Drizzle 0.45, postgres.js 3.4, Zod 3.25, BullMQ 5.81, Vitest 3.2, Playwright 1.63, TypeScript 5.9 (TypeScript 7 / Vitest 5 / Zod 4 skipped for now to keep the toolchain on well-understood majors).
- Built schema and initial migration; seed catalogue for plans, roles and permissions.
- Implemented entitlements, tenancy/RBAC, auth with 2FA, storage, projects. 55 tests passing on first run; mutation-checked the concurrency test.
- Built the web app and worker. Issues found and fixed during E2E:
  - invalid `<p><div>` nesting caused a hydration mismatch → header description is a `div`;
  - `instanceof AppError` failed across duplicated server chunks → symbol-branded `isAppError`;
  - forms cleared typed values after an error (React form-action reset) → manual submit in `ActionForm`;
  - dev-server reloads mid-test from files written inside the repo → dev storage and Playwright artifacts moved outside the repo; E2E now runs against a production build;
  - Google Fonts blocked/third-party → fonts self-hosted, CSP tightened to `'self'`;
  - production env rule rejected `http://localhost` → loopback allowed, everything else must be https.
- Added Dockerfiles, Compose stack, Nginx config, backup/restore scripts, deployment guide.
- Final: 56 unit/integration + 3 E2E tests passing; typecheck clean; production build succeeds.
