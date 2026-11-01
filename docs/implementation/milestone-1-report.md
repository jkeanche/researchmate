# Milestone 1 report: foundation

Date: 1 November 2026

## Scope delivered

Authentication, multi-tenancy, basic research projects, free and paid plan definitions, a centralised entitlement service, local file storage with quota enforcement, a basic dashboard and optional TOTP 2FA (blueprint §37), plus the Docker/Nginx deployment setup and a background worker.

## Architecture decisions

Summarised in [architecture/decisions.md](../architecture/decisions.md). Highlights:

- Modular monolith in a pnpm workspace; domain packages with one-way dependencies.
- Drizzle ORM with committed SQL migrations; reference data (plans, roles, permissions) synced idempotently after migration without overwriting admin edits.
- First-party database sessions (HMAC-hashed tokens), Argon2id passwords, RFC 6238 TOTP with replay protection, HMAC-hashed single-use recovery codes.
- Entitlements resolved per organization from database plans plus admin overrides; no plan-name checks in code.
- Race-free quotas via organization row locks and expiring upload reservations.
- Streaming uploads with server-side content detection; hardened downloads.

Blueprint gaps and the decisions taken are in [spec-review.md](spec-review.md).

## Modules created

| Package | Contents |
|---|---|
| `@researchmate/shared` | Zod env validation (fails on missing/weak secrets; production rules), AES-256-GCM secret encryption, token/HMAC helpers, `AppError`, JSON logger, queue names |
| `@researchmate/database` | Schema (22 tables), migration `0000_initial`, client, migrator, seed catalogue for 4 plans × 20 features, 12 roles, 19 permissions |
| `@researchmate/entitlements` | `getEntitlements`, `canUseFeature`, `requireFeature`, `checkIntegrationAccess`, `checkProjectQuota`, `checkFileQuota`, `checkStorageQuota`, `checkUploadQuota`, `checkMemberQuota`, `getUsage`, `getLimitStatus`, `lockOrganization` |
| `@researchmate/tenancy` | Organizations (with one-free-org-per-owner rule), membership management with role-rank protection, org/project permission resolution, audit log |
| `@researchmate/auth` | `AuthService` (register, verify email, login, 2FA challenge, logout, reset/change password, reauthenticate, 2FA enroll/confirm/disable, recovery codes), sessions, Redis rate limiter, email templates |
| `@researchmate/storage` | `StorageDriver` interface, local driver (atomic writes, byte caps, traversal-proof keys), content-type allowlist, `FileService` (upload, versions, download, soft delete, listing), maintenance (expire reservations, purge deleted files) |
| `@researchmate/research` | `ProjectService` (create with quota, read, update, archive/restore, list, upcoming deadlines) with validation |
| `apps/web` | Landing + pricing (from DB), register/verify/login/2FA/forgot/reset, dashboard, projects (list/new/detail/edit), files library, organization (plan usage, members), profile, security (2FA, password, devices); `PUT /api/files`, `GET /api/files/:id/download`, `GET /api/health` |
| `apps/worker` | Email delivery (SMTP, retries), scheduled maintenance, `create-admin` CLI |

## Database migrations

`packages/database/migrations/0000_initial.sql` creates:

users, user_profiles, sessions, auth_tokens, two_factor_settings, two_factor_recovery_codes, security_events, organizations, organization_members, roles, permissions, role_permissions, audit_logs, plans, plan_entitlements, organization_entitlement_overrides, subscriptions, research_projects, project_members, files, file_versions, file_storage_reservations, file_processing_jobs.

Constraints include: lower-case unique emails, one live subscription per organization (partial unique index), single default plan, status/type/citation-style CHECKs, progress 0–100, completion ≥ start date, non-negative sizes, unique storage keys and (file, version) pairs.

## Environment variables

Read in this milestone: `NODE_ENV`, `APP_URL`, `APP_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`, `STORAGE_DRIVER`, `LOCAL_STORAGE_ROOT`, `MAX_UPLOAD_SIZE_MB`, `FILE_RETENTION_HOURS`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `EMAIL_FROM`, `REQUIRE_EMAIL_VERIFICATION`, `SESSION_TTL_DAYS`, `WORKER_CONCURRENCY`; Compose also uses `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `TLS_CERT_DIR`. The remaining blueprint variables are listed in `.env.example` for later milestones and are not read yet.

## Tests executed and results

| Suite | Command | Result |
|---|---|---|
| Unit | `pnpm test` (tests/unit.test.ts) | 19 passed |
| Auth integration | tests/auth.test.ts | 17 passed |
| Entitlements, quotas, storage | tests/entitlements-storage.test.ts | 16 passed |
| Tenancy and RBAC | tests/tenancy.test.ts | 4 passed |
| End-to-end (production build, Chrome) | `infrastructure/scripts/e2e-local.sh` | 3 passed |
| Typecheck | `pnpm typecheck` | all 9 workspaces clean |
| Production build | `pnpm build` | succeeds |

**56 unit/integration tests + 3 end-to-end tests, all passing.** Integration tests run against a real PostgreSQL 16 database rebuilt from migrations on every run.

Coverage of the blueprint's acceptance list for this milestone:

- Free plan: one project (including archived), one file across the account, 5 MB per file and total, no AI processing flag, no processing jobs queued, restricted integrations denied.
- Concurrency: 5 parallel project creations and 6 parallel uploads on Free each yield exactly one success. A mutation check confirmed the upload test fails if the organization lock is removed.
- Storage: local driver, quota enforcement, size mismatch rejection, content/extension mismatch rejection with reservation release, versioning counted in storage, delete frees quota, retention purge erases bytes but keeps metadata, expired reservations stop counting.
- Security: tenant isolation (projects, files, uploads into other tenants), role permissions incl. finance separation, role escalation prevention, hashed session/verification tokens, session revocation (logout, revoke others, disabled user), password reset revokes sessions and is single-use, generic login errors, rate limiting, 2FA enrollment requires verification, encrypted TOTP secret, TOTP replay rejected, challenge lockout after 5 attempts, recovery codes single-use and invalidated on regeneration, disabling requires password + code, cross-origin uploads refused, protected routes redirect/401.
- E2E: register → refused before verification → verify via emailed link → sign in → create project → Free project limit shown → upload → Free file limit returned by server → download bytes match → enable 2FA → recovery codes shown → sign out → sign in with TOTP → phone-width layout without horizontal overflow.

## Known limitations

- **Docker images and Nginx config were not built/run here** (no Docker daemon in the build environment). Compose syntax and shell scripts were validated; the web standalone server, worker and migrations were run directly with Node in production mode. First deploy should be watched closely.
- **S3-compatible storage** is not implemented yet (selecting it fails at startup by design). Phase 4.
- **No online payments.** Plans are assigned by a platform admin (SQL in the deployment guide). Phase 13.
- **No admin UI** yet; administration is via SQL and the `create-admin` CLI.
- **Email invitations** for people without accounts are not implemented; owners add existing verified users by email.
- **Email address change** and account deletion are not implemented.
- **Organization-level mandatory 2FA** and passkeys are not implemented.
- File processing (extraction, OCR, embeddings), Mastra and all AI features are intentionally absent; uploads are stored only.
- Malware scanning is not implemented; uploads are restricted to an allowlist validated by content, and served as attachments with a sandbox CSP.
- Project progress is set manually until planning (Phase 6) derives it from tasks.
- The CSP allows `'unsafe-inline'` scripts because Next.js injects inline bootstrap scripts; a nonce-based CSP is a hardening follow-up.
- The worker runs TypeScript via `tsx` rather than a compiled bundle.

## Commands

```bash
pnpm install
pnpm db:migrate
pnpm dev                 # web
pnpm dev:worker          # worker
pnpm admin:create
pnpm test && pnpm typecheck
bash infrastructure/scripts/e2e-local.sh
docker compose build && docker compose run --rm migrate && docker compose up -d
```

## Next milestone (recommended)

Per the blueprint's guidance, planning and finances before AI:

1. **Phase 4 completion:** S3 driver tested against MinIO; file previews.
2. **Phase 5:** research questions, objectives, hypotheses, tasks, milestones, workflow templates, time entries.
3. **Phase 6:** interactive Gantt bound to task records with server-validated drag/drop, four dependency types with cycle detection, baselines that are never overwritten, Kanban, calendar, risk register; progress derived from tasks.
4. Small foundation follow-ups: email invitations, admin UI for plans/overrides/subscriptions, account email change.
