# Implementation log

Newest first. One entry per working session.

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
