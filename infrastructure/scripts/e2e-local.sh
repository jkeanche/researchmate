#!/usr/bin/env bash
# Runs the Playwright suite against a production build on this machine.
# Requires Postgres and Redis already running and a migrated database
# (DATABASE_URL / REDIS_URL from .env). Uses a local SMTP sink for email.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
set -a; source .env; set +a

MAIL_LOG="${E2E_MAIL_LOG:-/var/tmp/researchmate-mail.log}"
: > "$MAIL_LOG"
# Payments go to a local fake of the provider APIs (tests/support/fake-payments.ts).
export PAYSTACK_SECRET_KEY=sk_test_paystack_fake PAYSTACK_BASE_URL=http://127.0.0.1:4010/paystack PAYSTACK_CURRENCIES=USD,KES
export ALLOW_PRIVATE_ENDPOINTS=true NODE_ENV=production EMAIL_HOST=127.0.0.1 EMAIL_PORT=2525 E2E_MAIL_LOG="$MAIL_LOG" PORT=3000 HOSTNAME=127.0.0.1
export METRICS_TOKEN="${METRICS_TOKEN:-e2e-metrics-token-0123456789abcdef}"

pids=()
# Job control gives each background job its own process group, so cleanup also
# stops child processes (pnpm exec → node); otherwise a stale fake server keeps the port.
set -m
cleanup() { for p in "${pids[@]}"; do kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# Repeated local runs would otherwise trip the registration/login rate limits.
redis-cli -u "$REDIS_URL" --scan --pattern "rl:*" | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null

python3 infrastructure/scripts/smtp-sink.py --port 2525 --out "$MAIL_LOG" & pids+=($!)
pnpm exec tsx tests/support/fake-payments-server.ts > /var/tmp/researchmate-fakepay.log 2>&1 & pids+=($!)

pnpm --filter @researchmate/web build
STANDALONE=apps/web/.next/standalone
cp -r apps/web/.next/static "$STANDALONE/apps/web/.next/static"
[ -d apps/web/public ] && cp -r apps/web/public "$STANDALONE/apps/web/public"
node "$STANDALONE/apps/web/server.js" > /var/tmp/researchmate-web.log 2>&1 & pids+=($!)
(cd apps/worker && node --import tsx src/index.ts > /var/tmp/researchmate-worker.log 2>&1) & pids+=($!)

for i in $(seq 1 30); do curl -fs http://127.0.0.1:3000/api/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:3000/api/health

E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test "$@"
