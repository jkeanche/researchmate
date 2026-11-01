# ResearchMate AI

A multi-tenant research workspace: plan research, manage sources and files, and write, from first idea to final submission.

This repository is being built in phases (see the blueprint and `docs/implementation/`). **Milestone 1** delivers the foundation: authentication with optional TOTP 2FA, organizations and RBAC, plan entitlements and quotas, research projects, local file storage with versioning, a dashboard, a background worker and a production deployment setup.

## Requirements

- Node.js 22+, pnpm 10 (`corepack enable`)
- PostgreSQL 16 (pgvector image used in Docker), Redis 7

## Local development

```bash
pnpm install
cp .env.example .env
# Edit .env for local use:
#   NODE_ENV=development
#   APP_URL=http://localhost:3000
#   APP_SECRET=$(openssl rand -base64 48)
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   DATABASE_URL=postgres://postgres@localhost:5432/researchmate
#   REDIS_URL=redis://localhost:6379/0
#   LOCAL_STORAGE_ROOT=/var/lib/researchmate-dev   # keep outside the repo
ln -s ../../.env apps/web/.env

pnpm db:migrate        # migrations + plans/roles/permissions
pnpm dev               # web on http://localhost:3000
pnpm dev:worker        # worker; without SMTP it prints emails (verification links) to the console
pnpm admin:create      # optional: create a platform administrator
```

## Tests

```bash
createdb researchmate_test       # once
pnpm test                        # unit + integration (real Postgres, Redis not required)
pnpm typecheck
bash infrastructure/scripts/e2e-local.sh   # production build + Playwright (needs Chrome)
```

`TEST_DATABASE_URL` overrides the test database (default `postgres://postgres@localhost:5432/researchmate_test`). The suite drops and recreates its schema on every run.

## Production

See [docs/deployment/ubuntu-vps.md](docs/deployment/ubuntu-vps.md). In short:

```bash
cp .env.example .env    # fill in secrets, SMTP, domain
docker compose build
docker compose run --rm migrate
docker compose up -d
```

## Repository layout

```
apps/web            Next.js app (pages, server actions, upload/download/health routes)
apps/worker         Background jobs: email delivery, maintenance schedules, admin CLI
packages/shared     Env validation, encryption, errors, logger
packages/database   Drizzle schema, migrations, plan/role catalogue
packages/entitlements  Plans, quotas, usage, organization locks
packages/tenancy    Organizations, memberships, permissions, audit log
packages/auth       Passwords, sessions, 2FA, rate limiting, email templates
packages/storage    Storage drivers, content validation, file service
packages/research   Research projects
infrastructure/     Dockerfiles, Nginx, backup/restore and test scripts
docs/               Architecture decisions, blueprint review, deployment, milestone reports
tests/              Vitest unit/integration tests and Playwright E2E
```

## Documentation

- [Blueprint review](docs/implementation/spec-review.md): gaps found and the decisions taken
- [Architecture decisions](docs/architecture/decisions.md)
- [Milestone 1 report](docs/implementation/milestone-1-report.md)
- [Implementation log](docs/implementation/log.md)
