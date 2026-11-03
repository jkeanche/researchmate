# ResearchMate AI

A multi-tenant research workspace: plan research, manage sources and files, and write, from first idea to final submission.

This repository is being built in phases (see the blueprint and `docs/implementation/`).

- **Milestone 1:** authentication with optional TOTP 2FA, organizations and RBAC, plan entitlements and quotas, research projects, local file storage with versioning, a dashboard, a background worker and a production deployment setup.
- **Milestone 4:** Google Drive import/export (OAuth with PKCE, encrypted tokens) and the AI foundation: Mastra agents with your own provider key, background runs, metering, and suggestions that need human approval.
- **Milestone 3:** optional project finances: versioned budgets, expenses with approvals, funding, multi-currency, task cost estimates, dashboard and CSV/XLSX/PDF reports.
- **Milestones 5–10:** reference library and evidence; document engine with DOCX/PDF export; supervisor reviews; AI billing and payments; MCP, Apify and web capture; and a research toolkit (datasets and deterministic statistics, Mermaid diagrams, questionnaires, sample-size calculators, generated decks and status reports).
- **Milestone 11:** production hardening: notifications, project search, malware scanning, workspace/account deletion with retention, metrics and alerting, verified backups, foreign-key indexes, separate worker and scheduler services.
- **Milestone 2:** S3-compatible storage; research questions, objectives and hypotheses; configurable workflows with approval gates; tasks, milestones and four dependency types; an interactive Gantt chart with server-validated drag scheduling, critical path, immutable baselines and export; schedule proposals; Kanban, calendar, work breakdown, risk register, time tracking and workload.

## Requirements

- Node.js 22+, pnpm 10 (`corepack enable`)
- PostgreSQL 16 (pgvector image used in Docker), Redis 7
- For document export and OCR (worker): LibreOffice Writer with `python3-uno`, poppler-utils and Tesseract. The Docker worker image includes them; locally, the related tests are skipped if they are missing.

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
pnpm --filter @researchmate/worker demo:seed   # optional: demo researcher with a planned thesis (dev only)
```

To use S3-compatible storage instead of the local disk, set `STORAGE_DRIVER=s3` and the `S3_*` variables in `.env` (see `.env.example`).

## Tests

```bash
createdb researchmate_test       # once
pnpm test                        # unit + integration (real Postgres, Redis not required)
pnpm typecheck
bash infrastructure/scripts/e2e-local.sh   # production build + Playwright (needs Chrome)
```

`TEST_DATABASE_URL` overrides the test database (default `postgres://postgres@localhost:5432/researchmate_test`). The suite drops and recreates its schema on every run.

The S3 driver tests run against a real S3-protocol server: set `TEST_S3_ENDPOINT` (e.g. a MinIO container), or install moto (`pip install "moto[server]"`) and the suite starts it itself. Without either, those tests are skipped with a warning.

## Production

Two supported ways to run it on Ubuntu:

- **Native, with the server's own Nginx and PostgreSQL:** [docs/deployment/ubuntu-native.md](docs/deployment/ubuntu-native.md). One command installs, configures and starts everything, and re-running it upgrades:

  ```bash
  sudo infrastructure/scripts/install-ubuntu.sh --domain research.example.org --email you@example.org --tls \
    --smtp-host smtp.example.org --smtp-user apikey --smtp-password-file /root/smtp-password --admin-email you@example.org
  ```

- **Docker Compose:** [docs/deployment/ubuntu-vps.md](docs/deployment/ubuntu-vps.md). In short:

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
packages/research   Projects, members, research questions/objectives, workflows and stages
packages/citations  CSL citation formatting (six styles), BibTeX/RIS
packages/literature Scholarly search, reference library, verification, text
                    extraction/OCR, evidence, literature matrix
packages/documents  Document templates, structured sections, DOCX writer,
                    LibreOffice PDF rendering and output validation
packages/collaboration  Invitations, supervisors, review requests, feedback,
                    revision tasks, waiting/revision time
packages/billing    Pricing versions, credit ledger, spending limits, payments
                    (Paystack, Pesapal, Stripe), invoices, subscriptions
packages/ai         Mastra agents, BYOK credentials, AI runs, metering, suggestions
packages/integrations  Google Drive, MCP registry, Apify, approved-website capture
packages/toolkit    Datasets and statistics, diagrams, questionnaires, sample size,
                    generated presentations and reports
packages/finance    Optional project finances: budgets, expenses, funding, FX, reports
packages/planning   Scheduling engine (pure) and planning service: tasks, dependencies,
                    baselines, proposals, risks, events, time, workload
infrastructure/     Dockerfiles, Nginx, Prometheus config and alerts, backup/verify/restore and test scripts
docs/               Architecture decisions, blueprint review, deployment, milestone reports
tests/              Vitest unit/integration tests and Playwright E2E
```

## Documentation

- [Blueprint review](docs/implementation/spec-review.md): gaps found and the decisions taken
- [Architecture decisions](docs/architecture/decisions.md)
- [Milestone 1 report](docs/implementation/milestone-1-report.md)
- [Milestone 2 report](docs/implementation/milestone-2-report.md)
- [Milestone 3 report](docs/implementation/milestone-3-report.md)
- [Milestone 4 report](docs/implementation/milestone-4-report.md)
- [Milestone 5 report](docs/implementation/milestone-5-report.md)
- [Milestone 6 report](docs/implementation/milestone-6-report.md)
- [Milestone 7 report](docs/implementation/milestone-7-report.md)
- [Milestone 8 report](docs/implementation/milestone-8-report.md)
- [Milestone 9 report](docs/implementation/milestone-9-report.md)
- [Milestone 10 report](docs/implementation/milestone-10-report.md)
- [Milestone 11 report](docs/implementation/milestone-11-report.md)
- [Payment providers](docs/architecture/payments.md)
- [Implementation log](docs/implementation/log.md)
