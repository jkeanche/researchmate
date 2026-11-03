# Architecture decisions (milestone 1)

## Shape

A **modular monolith** in a pnpm workspace. Domain packages expose plain TypeScript services; apps compose them.

```
apps/web        Next.js 16 (App Router): pages, server actions, upload/download routes
apps/worker     BullMQ worker: email delivery, scheduled maintenance, admin CLI
packages/
  shared        env validation, AES-GCM secret encryption, errors, logger, queue names
  database      Drizzle schema, migrations, seed catalogue (plans, roles, permissions)
  entitlements  plan resolution, quotas, usage, organization locking
  tenancy       organizations, memberships, RBAC, audit log
  auth          passwords, sessions, TOTP 2FA, recovery codes, rate limiting, email templates
  storage       storage driver interface, local driver, content validation, file service
  research      research projects
```

Dependency direction: `shared ← database ← entitlements ← tenancy ← {auth, storage, research} ← apps`. No package imports an app.

Packages export TypeScript sources; Next.js transpiles them (`transpilePackages`) and the worker runs them with `tsx`. No separate build step per package.

## Key decisions

| Decision | Why |
|---|---|
| **Drizzle ORM + SQL migrations** | Typed queries, readable generated SQL, check constraints and partial indexes expressed in schema. Migrations are committed and applied by `pnpm db:migrate`, which then syncs reference data. |
| **First-party session auth** instead of Auth.js | Requirements (DB sessions with per-device revocation, TOTP with replay protection, recovery codes, reauthentication, 2FA login challenge) are awkward to bolt onto Auth.js's credentials provider. The implementation follows the Lucia/Copenhagen Book pattern and is covered by tests. |
| Session token: 256-bit random, DB stores `HMAC(APP_SECRET, token)` | A database leak alone can't produce valid cookies. |
| Argon2id (19 MiB, t=2, p=1) | OWASP recommendation. |
| TOTP implemented in-house (RFC 6238) | ~60 lines, verified against RFC test vectors, avoids a dependency with changing APIs. Secrets encrypted with AES-256-GCM using user-bound associated data. Each time-step is accepted once. |
| Recovery codes hashed with HMAC | Codes have 50 bits of entropy, so a keyed hash is sufficient; single use is enforced by a conditional update. |
| **Entitlements per organization, data-driven** | Plans, values and per-org overrides live in the database. Code references feature keys from a typed catalogue, never plan names. Unknown/missing values default to "not available". |
| **Quota reservations under an organization row lock** | Makes concurrent uploads and project creation race-free without counters that can drift. Usage is always computed from source rows. |
| Streaming uploads via `PUT` with `Content-Length` | Quota is reserved before bytes are accepted; the body streams to disk with a hard byte cap; content type is detected from magic bytes and must match the extension. Nothing is buffered in memory. |
| Downloads | `Content-Disposition: attachment` except PDFs/images on request, `nosniff`, sandbox CSP, no caching. |
| Opaque storage keys `org/yyyy/mm/uuid` | Never derived from user filenames; path traversal is impossible by construction and re-checked in the driver. |
| CSRF | Server actions use Next's built-in origin check; route handlers require `Origin === APP_URL`; cookies are `SameSite=Lax`, `HttpOnly`, `__Host-` prefixed in production. |
| Security headers | CSP (no third-party origins; fonts self-hosted), frame-ancestors none, nosniff, HSTS in production. |
| Errors | Services throw `AppError` with safe, user-facing messages; unexpected errors are logged and shown generically. Detection uses a symbol brand, not `instanceof`, because bundlers may load a module twice. |
| Non-disclosure | Requests for another tenant's organization, project or file return *not found*, never *forbidden*. |
| Email via queue | Web enqueues; worker delivers with exponential retries. Auth flows never fail or leak account existence because of email. |
| Text columns + CHECK constraints instead of Postgres enums | Easier to evolve with plain migrations. |

## Data model (milestone 1)

Identity: `users`, `user_profiles`, `sessions`, `auth_tokens`, `two_factor_settings`, `two_factor_recovery_codes`, `security_events`.
Tenancy: `organizations`, `organization_members`, `roles`, `permissions`, `role_permissions`, `project_members`, `audit_logs`.
Billing/entitlements: `plans`, `plan_entitlements`, `organization_entitlement_overrides`, `subscriptions` (one live subscription per org, enforced by a partial unique index).
Research: `research_projects`.
Files: `files`, `file_versions`, `file_storage_reservations`, `file_processing_jobs`.

## RBAC

Effective project permissions = project-scoped permissions from the organization role ∪ permissions from the project role. Organization owners see everything; admins see all research but not finances; finance managers see finances on every project but cannot edit research or read files. Roles carry a rank so members cannot grant or modify roles above their own. Role grants are data and cached for 30 seconds.

# Milestone 2 additions: storage, research management and planning

## Shape

```
packages/research   + research content (questions, objectives, hypotheses), project members,
                      workflow templates → project stages
packages/planning   engine (pure, client-safe: @researchmate/planning/engine)
                    + PlanningService (DB): tasks, dependencies, baselines, proposals,
                      checklists, comments, assignments, risks, events, time, workload
packages/storage    + S3-compatible driver
```

Dependency direction is unchanged: `planning` depends on `research`, never the reverse.

## Key decisions

| Decision | Why |
|---|---|
| **Scheduling engine as pure functions** | Dependency rules, cascades, critical path, forecast and variance are deterministic and unit-tested without a database (29 tests). The service only loads rows, calls the engine inside a transaction and persists the result. The same module could run in the browser for previews. |
| **Half-open day intervals; milestones at end of day** | A task is `[start, end + 1)`; a milestone is a point at the end of its day. This makes all four dependency types (FS, SS, FF, SF) one formula each, and gives expected results: a milestone after a task lands on the task's last day; a task after a milestone starts the next day. |
| **Calendar days, no working-day calendar** | Research schedules span months and many researchers work weekends; a holiday calendar per country/institution is a later feature. The proposal generator states this assumption explicitly. |
| **Milestones are tasks with `kind = milestone`** | One table means dependencies, the Gantt chart, the critical path and baselines treat them uniformly. The blueprint's separate `research_milestones` table is not needed. |
| **Summary tasks roll up** | A task with subtasks takes its dates and progress from its children. Moving a summary moves its subtree; resizing it is refused. Dependencies on a summary apply to its whole subtree (this is how cycles are detected). |
| **Forward-push cascades; no automatic pull-back** | When work moves later, successors move later so every dependency holds. Nothing is pulled earlier automatically, so slack the user created is never silently consumed. An edit that would start a task before its own predecessors allow is refused with the exact earliest date. |
| **Approved deadlines are locked** | `deadline_locked` items can only be moved by a user with `project.plan.approve`, who must explicitly confirm (and give a reason). A cascade that would move a locked deadline fails as a whole. This is the mechanism that will stop future AI agents from silently changing approved deadlines. |
| **Every date change is recorded** | `project_schedule_revisions` stores old/new dates, who, why and the source (manual, Gantt, cascade, roll-up, proposal, locked override). |
| **Baselines are append-only, enforced by the database** | Triggers reject `UPDATE` on baselines and their items and reject `DELETE` unless the owning project (or baseline) is being deleted. Baseline items keep task title and dates without a foreign key, so deleting a task doesn't erase history. |
| **Proposals before changes** | Generated schedules are stored as `schedule_proposals` (source `template` now, `ai` later). Nothing touches the plan until an approver accepts; acceptance only adds tasks, never edits existing ones. |
| **Optimistic concurrency on tasks** | Tasks carry a `version`. The Gantt chart sends it; a stale write gets a 409 and the client reloads. Plan writes also take a row lock on the project, so cascades never interleave. |
| **Field-level permissions on tasks** | Plan fields (dates, structure, owner) need `project.plan.manage`; progress fields need that or `project.tasks.work` on one's own task; locking deadlines needs `project.plan.approve`. The form action sends only changed fields so an assistant can save progress from the same form. |
| **In-house SVG Gantt instead of a library** | Requirements: four dependency types, baseline overlay, critical-path highlighting, server-validated drag with locked-deadline confirmation, keyboard operation and standalone export. frappe-gantt draws only finish-to-start links and has no baselines; dhtmlxGantt is GPL/commercial; SVAR's baseline support is in its paid edition. The component is ~500 lines of React/SVG over the real task records with no extra runtime dependency. |
| **Export: PNG and SVG in the browser, PDF via print** | The chart is SVG with resolved colours, so it serialises to a standalone SVG and rasterises to PNG on a canvas. PDF uses the browser's print-to-PDF with a landscape print stylesheet; server-side PDF rendering arrives with the document engine (LibreOffice container). |
| **Planning tiers** | `planning.gantt`: `overview` (Free) = tasks and milestones up to `planning.tasks.max` (20) per project, list, board, work breakdown, calendar and a read-only timeline. `full` = dependencies, drag scheduling, critical path, baselines, proposals, risks, events, time tracking, workload. Reads are never gated, so downgraded projects stay visible. |
| **Workflow templates are copied, not referenced** | Applying a template copies its stages into `project_stages`; later template changes never alter existing projects. Templates are seeded by `(key, version)` and never edited in place. |
| **Approval wait time is measured** | Stages record when they entered `awaiting_approval` and accumulate waiting seconds on each decision; this is the "supervisor waiting time" the blueprint asks to track separately. |
| **Progress follows tasks by default** | Project progress = duration-weighted progress of leaf tasks (done = 100 %, cancelled excluded). Projects created before this milestone were switched to `manual` by the migration so their hand-set values are kept. |
| **S3 driver streams multipart uploads** | Bounded memory (8 MB parts), a hard byte cap, and abort on error so no object or orphaned multipart upload remains. Keys use the same validation as the local driver, with an optional prefix. Tested against moto's S3 server (real S3 protocol). |
| **CSS layers** | Component classes (`.input`, `.btn`, `.field`) now live in `@layer components` and the link reset in `@layer base`, so Tailwind utilities override them as intended. Previously unlayered rules silently beat utilities (e.g. `w-24` on an input). |

## Data model (milestone 2)

Migration `0001_planning` adds:

Research: `research_questions`, `research_objectives` (with `question_id` for alignment), `research_hypotheses`.
Workflow: `workflow_templates`, `workflow_stages`, `project_stages`; `research_projects.workflow_template_key/version`, `progress_source`.
Planning: `research_tasks` (tasks and milestones, hierarchy, versions, locks), `task_dependencies`, `task_checklist_items`, `task_comments`, `project_resource_assignments`, `research_time_entries`, `project_schedule_baselines`, `project_schedule_baseline_items`, `project_schedule_revisions`, `schedule_proposals`, `project_risks`, `project_calendar_events`.

## RBAC additions

New project permissions: `project.plan.manage`, `project.plan.approve`, `project.tasks.work`.

| Project role | Planning rights |
|---|---|
| Lead researcher | all, including approvals, baselines and locked deadlines |
| Researcher | manage the plan and research content; no approvals |
| Research assistant | progress, checklists and time on tasks assigned to them |
| Supervisor | read, comment, approve or return workflow stages |
| Finance manager / viewer | read only |

## Literature (milestone 5)

| Decision | Reason |
|---|---|
| **Citations via citeproc-js and official CSL styles** | Deterministic formatting, with numbering and disambiguation computed per document. Styles are vendored (CC BY-SA) and read from disk; the standalone build traces them and `CSL_DIR` can override the location. |
| **Signed search results** | Provider provenance is recorded only for HMAC-signed results rendered by the server within the last day. |
| **Extraction in the worker on a `files` queue** | Triggered by `FileService.afterStore` for every stored version, from uploads and Drive imports alike. It skips files with AI processing off. OCR (poppler and Tesseract) is used only for PDFs with no text layer. |
| **Anti-fabrication is post-validation** | Verbatim quote matching and citation-key checks run on the model's structured output before anything is stored. |

## Documents (milestone 6)

| Decision | Reason |
|---|---|
| **One model for preview, DOCX and validation** | `assemble()` numbers headings, tables, figures and equations, resolves citations and counts words once. The preview, the DOCX writer and the checks all consume it, so what is checked is what is rendered. |
| **LibreOffice + Python-UNO for PDF** | A real layout engine. Each job gets its own profile and pipe, so jobs are isolated and concurrent. UNO updates the contents (twice) before export; without UNO a plain conversion is used and reported. |
| **PDF inspection with a transform-matrix walk** | Text positions come from pdf.js; image boxes are computed by tracking save/restore/transform operators. This lets margin overflow be detected for images as well as text. |
| **Snapshots for exports** | Every export first creates an append-only version, and the worker renders that snapshot with the specification version it references. Exports are reproducible and unaffected by later edits. |
| **Table names** | The blueprint's `document_artifacts` is `documents`; `document_specifications` is the `spec_version` pointer on `documents` plus `document_specification_versions`. Evidence links live in `document_section_evidence`. |
| **Metric-compatible fonts** | Times New Roman, Arial and Calibri are named in specifications. The worker image ships Liberation and Carlito/Caladea so line breaks and page counts match Word. |

## Collaboration (milestone 7)

| Decision | Reason |
|---|---|
| **Reviews point at immutable versions** | A submission references a `document_versions` snapshot (and optionally a PDF export of it). Feedback anchors to section keys in that snapshot, so comments stay meaningful while the researcher keeps writing. |
| **No self-approval, in two places** | The service refuses it, and a check constraint (`decided_by_user_id is distinct from submitted_by_user_id`) makes it impossible even for code that bypasses the service. |
| **Invitation tokens like other auth tokens** | 32 random bytes, stored as `HMAC(APP_SECRET)`, single use, expiring, resend rotates. Acceptance requires a verified account with the invited address. |
| **LibreOffice process groups** | Conversion spawns LibreOffice detached, kills the group and waits for exit before removing the profile. Cleanup errors are swallowed so they can never mask a successful render. |

## Billing (milestone 8)

| Decision | Reason |
|---|---|
| **Micro-USD ledger, append-only, two pools** | Integer micro-dollars avoid rounding drift on tiny AI charges. The monthly allowance pool is used before prepaid credit and is computed per period. Every entry is idempotent. |
| **Immutable pricing versions** | Charges reference the version; triggers stop edits to active or retired versions, so past invoices can always be explained. |
| **Verify, then fulfil, once** | Notifications only trigger a status fetch; fulfilment is a locked pending → succeeded transition checked against amount and currency. |
| **Payment adapters behind one interface** | Paystack, Pesapal and Stripe today; Daraja or Paddle can be added without touching the ledger or fulfilment. Base URLs are configurable for sandboxes and tests. |
| **Prepaid periods** | Works with M-PESA and cards alike; downgrades are a documented read-only policy, never deletion. |
| **Statistics in code, not in a sandbox or LLM** | Common tests are implemented directly (jStat only for distributions) and checked against SciPy, so results are deterministic and fast with no execution sandbox to secure. Each saved analysis carries its method text. Scripted analysis (R/Python) can be added later behind a sandboxed service. |
| **Datasets stored as JSONB copies** | A dataset is a snapshot of a file version plus ordered cleaning steps, which makes analyses reproducible and keeps the source file untouched; capped at 100,000 rows and 20 MB to keep it in-process. |
| **Mermaid rendered client-side, strict** | Editable text diagrams with precise labels (§10.2). `securityLevel: "strict"` plus a server check on init directives; SVG text labels keep PNG export untainted. |
| **Generated outputs never invent content** | Decks and reports use only recorded project data and show placeholders for empty sections. |
| **Notifications via a savepointed `notify()` + email outbox** | Every service already depends on tenancy, so notices are written in the caller's transaction without new dependencies; a failing notice can't undo the action; the worker delivers email with SKIP LOCKED and the email queue's retries. Security notices can't be silenced. |
| **Search with PostgreSQL full-text, permissions resolved first** | One ranked UNION over project-scoped tables; the query only ever sees project ids the user can read (and file content only with file permission). No separate search engine to secure or keep in sync. |
| **Purge, don't cascade blindly; pseudonymise users** | Append-only guards allow DELETE only for an organization marked as purging; financial records are copied out first. Users are pseudonymised because hard deletes would rewrite append-only audit rows. |
| **Fail closed on malware scanning** | When ClamAV is configured but unreachable, uploads are refused rather than stored unscanned. |
| **Metrics are counts only, internal only** | Token-protected and blocked at Nginx; no names, emails or content in labels. |

