# Milestone 11 report: production hardening

Date: 2 November 2026 · Blueprint phase 16 (security, testing, monitoring, backup, performance, deployment). This milestone also closes §30 (notifications), §31 (search) and the §29 retention and deletion requirements, which no earlier phase owned.

## What was built

### Notifications (§30)

- **Storage and preferences:** in-app notifications plus email, with per-user preferences (`notifications`, `notification_preferences`).
- **Security alerts are locked:** their email can't be turned off, so a hijacked session can't silence them.
- **No action is lost to a notice failure:** every notice is written by `notify()` in a savepoint that never throws. Repeats are suppressed by a per-recipient dedupe key.
- **Email delivery:**
  - pending email is claimed every minute with `FOR UPDATE SKIP LOCKED` (so parallel workers can't double-send) and handed to the email queue, which retries with backoff;
  - unverified or disabled users are skipped.

What triggers a notice:

| Event | Who is told |
|---|---|
| Task due within 2 days; task overdue (2-week look-back, so a first run doesn't flood); milestone within 7 days | Assignee (or the project owner); milestones go to everyone on the project. Hourly scan, once per due date. |
| Workflow stage completed / awaiting approval | Project members / reviewers |
| Review requested; supervisor decision | Reviewer; submitter (replaces the old direct emails) |
| Document export ready, or failed (with the count of failed checks) | Requester |
| Storage at 80% or full | Workspace owner, once per level and month |
| AI allowance 80% used; credit below $1; spending at 90% of the monthly cap | Owner |
| Project spending past the alert threshold or 100% of budget | Finance readers |
| Expense awaiting approval | Approvers, not the submitter |
| Funding added or received | Finance readers |
| Payment received or failed; renewal reminder; past due; plan ended | Payer / owner (replaces the old direct emails) |
| Google Drive needs reconnecting | The connected user |
| Password changed or reset; 2FA on/off; recovery codes regenerated or used; other sessions signed out; **sign-in from a new device or network** (not on the first sign-in) | The user, always emailed |

**UI:** a Notifications item with an unread badge, a list with "mark read" and "mark all", and Settings → Notifications (a grid of in-app and email choices per notice).

### Search (§31)

`searchProjects()` searches a project, or every active project the user can open in the workspace. It covers:
- references, evidence and extracted file text;
- file names and document sections;
- tasks and task comments, and supervisor feedback;
- research questions, objectives and hypotheses;
- risks and calendar events.

It is one ranked `UNION` using PostgreSQL English full-text search, websearch syntax (quoted phrases, `OR`, `-word`) and highlighted snippets.

**Permissions are resolved before the query:**
- only projects the user can read are searched;
- file names and file text are searched only where they also hold `project.files.read`.

Snippets are plain text with `«»` markers, rendered as text (never HTML). The pages are Search (workspace-wide) and a Search tab in each project. pgvector semantic search was not added; full-text search covers the stated record types.

### Security (§29, §33)

- **Malware scanning (optional):**
  - a clamd INSTREAM client scans every upload after it is stored and before it is committed;
  - infected files are deleted, their quota is returned, and the attempt is logged;
  - **fails closed** (HTTP 503) while the scanner is unreachable;
  - enabled by `CLAMAV_HOST`, with a Compose profile `clamav`.
- **Workspace deletion:**
  - owner only; requires the password (and 2FA code) plus typing the workspace's name;
  - access ends at once, and the owner can restore it for 30 days;
  - then a nightly purge deletes the projects, files and stored objects, documents, credentials and memberships, after copying invoices, payments and the ledger to an immutable `retained_financial_records` table;
  - the org-level append-only guard now allows DELETE only for an organization marked `purge_started_at` (UPDATE is still always refused), and the existing project-level guards already allow deletes once the parent is gone;
  - a user left with no workspace lands on a new `/workspace` page (restore or create). Before, an app layout that required a workspace would redirect in a loop.
- **Account deletion:**
  - requires reauthentication, and is refused while the user owns a workspace with other members;
  - schedules the user's solo workspaces for deletion and ends memberships;
  - removes sessions, 2FA secrets, recovery codes, API keys, Drive tokens and notifications;
  - **pseudonymises** the user row (email, name, password replaced; status disabled). Hard deletion would turn foreign-key "set null" into UPDATEs that the append-only audit and finance tables refuse; pseudonymising keeps those trails intact without identifying the person.
- **Dependency audit:** `pnpm audit --prod` went from 27 findings (7 high) to 2 known items:
  - fixed: nodemailer upgraded 7.0.13 → 10.1.7 (19 advisories); katex, uuid and image-size pinned to patched versions via pnpm overrides (decks, workbooks and diagrams re-verified);
  - **zod 3.25.76 (high, memory exhaustion on oversized collections):** no 3.x fix exists. The current mitigation is that request bodies are capped (server actions 1 MB; uploads stream and are size-checked). Migrating to zod 4 is listed as follow-up work;
  - **minimatch** inside exceljs → archiver → glob: no compatible patched version for that old glob, and the vulnerable code path (directory archiving) is never used.
- **Duplicate emails removed:** password-change and 2FA emails were sent both directly and as notices; now only the notice sends them.

### Monitoring

- **Worker heartbeat:** every 30 s the worker writes a Redis key and a file. `/api/health` now reports `worker: ok | missing` without failing the web container's health check.
- **`GET /api/metrics`:** Prometheus text format, behind a bearer token (404 when `METRICS_TOKEN` is unset). Nginx blocks it from outside, so it is reachable only inside the Docker network. It reports counts only (tested to contain no email addresses):
  - dependency status, worker up and heartbeat age, BullMQ jobs by queue and state;
  - users and organizations (active and pending purge), active projects;
  - notification emails pending and failed, age of the oldest pending export, failed exports;
  - AI runs in flight and failed, payments pending and failed, extraction jobs;
  - stored bytes, failed sign-ins per hour, process memory and uptime.
- **Compose profile `monitoring`:** Prometheus on `127.0.0.1:9090` with 10 alert rules:
  - app down, dependency down, worker missing;
  - queue backlog, failed jobs growing;
  - notification email stuck, export stuck;
  - spikes in payment failures or sign-in failures;
  - high memory.

### Backups

- **`backup.sh`:**
  - checks the dump lists cleanly;
  - optional GPG encryption to a public key (`BACKUP_GPG_RECIPIENT`; the private key stays off the server) and an off-site copy via rclone (`BACKUP_RCLONE_REMOTE`);
  - configurable retention (`BACKUP_KEEP`), and a warning when files live in S3.
- **New `verify-backup.sh`:**
  - checks the checksums and decrypts if needed;
  - restores into a **temporary database**, then checks migration history, the plan catalogue and row counts;
  - confirms every stored object the database references is in the archive, then drops the temporary database;
  - runs through Compose, or against any Postgres via `VERIFY_ADMIN_URL`.
- **Tested here with a real dump of the dev database and storage:**
  - a clean backup passes (13 migrations, 127 users, 35 file versions, 0 missing objects);
  - a tampered archive is refused;
  - an archive with one object removed names the missing file;
  - a GPG-encrypted backup verifies;
  - no temporary databases are left behind.

### Performance

- **Foreign-key indexes:** 54 were missing. Without them, joins and cascading deletes (project, document and workspace deletion) scan whole child tables. Migration `0012_fk_indexes` adds them. FKs to `users` (never hard-deleted) and to catalogue tables are deliberately exempt.
- **Guard tests:**
  - one fails if a new FK lacks an index;
  - one forces `enable_seqscan = off` and checks that six hot tenant-scoped queries (notifications, tasks, files, passage search, references, audit log) can use an index.

### Deployment

- **Worker roles:** `WORKER_ROLE=all | jobs | scheduler`.
  - Compose now runs `researchmate-worker` (jobs; scalable) and `researchmate-scheduler` (schedules only), matching the services named in §34;
  - an invalid role fails at start-up.
- **Worker health check:** the worker image has a `HEALTHCHECK` based on its heartbeat file.
- **Optional profiles:** `clamav` (with a signature volume) and `monitoring` (Prometheus with config and rules).
- **Environment:** the variable names from §35 (`DEFAULT_AI_PROVIDER`, `DEFAULT_AI_MODEL`, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_AI_API_KEY`, `APIFY_API_TOKEN`, `PAYMENT_PROVIDER`) are now real aliases, with unit tests; the explicit names win when both are set. `.env.example` was cleaned up: a stale "not read yet" block and a duplicate setting were removed, and new settings were documented.
- **Deployment guide:** new sections:
  - services and worker scaling;
  - backups (encryption, off-site copy, cron, verification);
  - monitoring;
  - malware scanning;
  - data retention and deletion.

## Data

| Migration | Contents |
|---|---|
| `0010_notifications` | `notifications`, `notification_preferences` |
| `0011_retention` | `organizations.purge_after` and `purge_started_at`; `retained_financial_records` (UPDATE refused); the purge-aware `rm_org_append_only` |
| `0012_fk_indexes` | 54 indexes |

## Tests

Unit and integration tests: **208**, up from 190. New files:
- `notifications.test.ts` (5): preferences, locking, dedupe, link validation, email delivery, security notices including new-device sign-in, the deadline scan, finance notices;
- `search.test.ts` (3): record types, phrase and exclusion syntax, workspace-wide search, tenant isolation, hostile queries;
- `retention.test.ts` (3): schedule, restore and purge through every append-only guard; other tenants untouched; account deletion;
- `clamav.test.ts` (3): a fake clamd speaking INSTREAM. It uses a harmless marker, not the EICAR string, which antivirus on a Windows checkout would quarantine;
- `performance.test.ts` (2).

Updated: billing and collaboration tests now assert notifications instead of emails. The unit tests gained the environment aliases and payment-provider order.

End-to-end: **15 tests, all passing**, up from 11. New specs:
- `notifications.spec.ts`;
- `retention.spec.ts`: delete the workspace, land on /workspace, restore it; delete the account; the old sign-in fails;
- `security.spec.ts`:
  - another user gets **404** on every resource route and page, and their search can't see the content;
  - stored-XSS attempt rendered as text;
  - CSP, frame, nosniff and referrer headers; session cookie HttpOnly and SameSite;
  - cross-origin server action refused; login rate limit;
  - metrics token required, and no personal data in metrics;
- literature spec: project search and workspace search.

Typecheck clean; production build succeeds.

### Bugs found and fixed during this milestone

1. **Deadline scan:** three queries shared one Drizzle builder (builders are mutable), so the last `.where()` won and every query returned milestones. Each query now builds its own; the test caught it.
2. **Redirect loop:** a user with no active workspace bounced between `/app` and a page inside `/app`. Fixed with the standalone `/workspace` page.
3. **Duplicate security emails:** see Security above.
4. **Spurious cleaning steps** (M10): already fixed.
5. **E2E harness leaked child processes:** a stale fake payment server kept port 4010, which made the billing spec fail with a unique-key collision on reused fake ids. The harness now uses process groups, and fake ids are unique per run. The suite had also outgrown the per-IP sign-up limit (10/hour, kept for production); a shared Playwright fixture now clears auth rate-limit counters before each test.

## Acceptance criteria (§33): where each is tested

| Lifecycle step | Covered by |
|---|---|
| 1 Register and sign in | `auth.test.ts`; every E2E spec |
| 2 Optional 2FA | `auth.test.ts` (enrolment, challenge, replay, single-use recovery codes, lock-out); `lifecycle.spec.ts` (enable, sign in with a code) |
| 3–4 Project and research requirements | `planning.test.ts`, `tenancy.test.ts`; `lifecycle.spec.ts`, `planning.spec.ts` |
| 5–7 Proposed schedule, Gantt edits, baseline | `planning-engine.test.ts`, `planning.test.ts`; `planning.spec.ts` |
| 8–9 Optional budget, expense with receipt | `finance.test.ts`; `finance.spec.ts` |
| 10 Upload documents | `entitlements-storage.test.ts`, `clamav.test.ts`; `lifecycle.spec.ts`, `literature.spec.ts` |
| 11–12 Google Drive connect and import | `drive.test.ts`, against a fake Google API (no E2E: real OAuth needs Google) |
| 13 Discover scholarly sources | `literature.test.ts`, with recorded provider responses (no live E2E query: external services) |
| 14 Extract evidence | `ai-literature.test.ts` (verbatim-quote check); `literature.spec.ts` |
| 15 Literature review draft | `ai-literature.test.ts` (refuses citations outside the library) |
| 16–18 Citation audit, edit, DOCX/PDF export | `documents.test.ts`; `documents.spec.ts` (LibreOffice render and validation) |
| 19–21 Supervisor invite, feedback, revision tasks | `collaboration.test.ts`; `supervision.spec.ts` |
| 22 AI usage and subscription | `ai.test.ts`, `billing.test.ts`; `ai.spec.ts`, `billing.spec.ts` |
| 23 Project spending and reports | `finance.test.ts` (CSV/XLSX/PDF); `finance.spec.ts` |

Other criteria:

| Criterion | Covered by |
|---|---|
| Free plan (one project, one file, 5 MB, no AI, no hidden AI, no integrations) | `entitlements-storage.test.ts`, `ai.test.ts`, `planning.test.ts`; `lifecycle.spec.ts` |
| Gantt and planning | `planning-engine.test.ts` (dependency types, cycles, cascades, critical path, overdue, baselines); `planning.test.ts` (persistence, concurrency) |
| Budget | `finance.test.ts` (optional, currencies, versions, approvals, no double counting, reconciliation, permissions, exports) |
| Storage | local and `s3-storage.test.ts`; quotas; concurrent uploads; Drive references cost nothing; imported copies counted (`drive.test.ts`) |
| Billing | BYOK never charged; metering; immutable pricing versions; idempotent ledger; spending limits; no fallback on a rejected key (`ai.test.ts`, `billing.test.ts`) |
| Security | tenant isolation (unit and HTTP); roles; 2FA; single-use recovery codes; session revocation; secret protection (keys and tokens encrypted, hints only); SSRF (`ai.test.ts`, `integrations.test.ts`); prompt-injection boundaries (MCP output wrapped as untrusted; AI drafts limited to the library); plus `security.spec.ts` |

## Not verified here

- **Container images weren't built.** Docker runs in this workspace, but its network allowlist blocks Docker Hub, so base images can't be pulled. `docker compose config` validates the file with every profile, and the YAML for Prometheus and the alerts parses. Run `docker compose build` and `docker compose --profile clamav --profile monitoring pull` on the server first; if the `prom/prometheus:v3.5.0` or `clamav/clamav:1.4` tags don't resolve, pick current tags.
- **Nginx config change not syntax-checked:** the one new `location` line wasn't checked by `nginx -t` (no image available).
- **`backup.sh` itself not run:** it needs the Compose stack. Its database and verification logic was exercised through `verify-backup.sh` against a real dump.
- **Live external services:** as in earlier milestones, SMTP delivery to real inboxes, Google, Paystack/Pesapal/Stripe, Apify and scholarly APIs are tested against fakes and recorded responses.

## Follow-up work

1. **Migrate to zod 4** (removes the last high-severity advisory).
2. **Semantic search with pgvector** alongside full-text search.
3. **Qualitative coding**, methodology matrices, posters (M10 list).
4. **Alerting:** Alertmanager or another pager integration.
5. **Admin tools:** UI for workspace ownership transfer, so an owner with members can leave.
