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
