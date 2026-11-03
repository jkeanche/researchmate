# Deploying on an Ubuntu VPS

Tested target: Ubuntu 22.04/24.04, 2 vCPU, 4 GB RAM, 40 GB disk (more disk for research files).

## 1. Prepare the server

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and in again
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

Point your domain's DNS A/AAAA record at the server.

## 2. Configure

```bash
git clone <your-repo-url> researchmate && cd researchmate
cp .env.example .env
```

Fill in `.env`:

- `APP_URL=https://your-domain`
- `APP_SECRET` → `openssl rand -base64 48`
- `ENCRYPTION_KEY` → `openssl rand -base64 32` (store a copy somewhere safe; losing it disables every user's 2FA)
- `POSTGRES_PASSWORD` → `openssl rand -hex 24` (hex avoids URL-escaping problems)
- `EMAIL_*` → your SMTP provider (required in production; notifications and security alerts are emailed)
- `METRICS_TOKEN` → `openssl rand -hex 24` if you'll use monitoring (section 8)
- Optional: `CLAMAV_HOST=clamav` to scan uploads for malware (section 9)

Edit `infrastructure/nginx/researchmate.conf` and replace `researchmate.example.com` with your domain.

## 3. TLS certificate

Obtain a certificate with certbot (standalone, before starting nginx):

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d your-domain
sudo mkdir -p infrastructure/nginx/certs
sudo cp /etc/letsencrypt/live/your-domain/{fullchain.pem,privkey.pem} infrastructure/nginx/certs/
```

Renewal: add a cron job that runs `certbot renew --pre-hook "docker compose stop nginx" --post-hook "cp … && docker compose start nginx"`, or point `TLS_CERT_DIR` at `/etc/letsencrypt/live/your-domain` (mount must follow symlinks; copying is simpler).

## 4. Start

```bash
docker compose build
docker compose up -d postgres redis
docker compose run --rm migrate          # applies migrations and syncs plans/roles
docker compose up -d
docker compose run --rm researchmate-worker node --import tsx src/scripts/create-admin.ts
curl -s https://your-domain/api/health
```

Services: `researchmate-web` (the app), `researchmate-worker` (background jobs; scale with `--scale researchmate-worker=2`), `researchmate-scheduler` (registers the recurring jobs; run one), `postgres`, `redis`, `nginx`. The worker image also runs `migrate`. Health is green when `checks.worker` is `ok`: if it says `missing`, emails, exports, text extraction and AI runs are not being processed.

## 5. Upgrades

```bash
git pull
docker compose build
docker compose run --rm migrate
docker compose up -d
```

Migrations are forward-only and additive by policy; take a backup first.

## 6. Backups

```bash
infrastructure/scripts/backup.sh /srv/researchmate-backups
```

Each backup holds `database.dump` (pg_dump, custom format), `files.tar.gz` (research files and generated documents) and `SHA256SUMS`. Settings in `.env`:

- `BACKUP_GPG_RECIPIENT` — encrypt both archives to a GPG public key. Keep the private key **off** the server (it's only needed to restore or verify).
- `BACKUP_RCLONE_REMOTE` — copy each backup off the server (configure the remote with `rclone config` first). A backup on the same disk doesn't survive losing the disk.
- `BACKUP_KEEP` — local backups to keep (default 14).

With `STORAGE_DRIVER=s3` research files live in the bucket: enable bucket versioning and replication there; the archive then holds only local generated files.

Schedule it daily, e.g. `/etc/cron.d/researchmate`:

```
15 2 * * * deploy cd /srv/researchmate && infrastructure/scripts/backup.sh /srv/researchmate-backups >> /var/log/researchmate-backup.log 2>&1
45 4 * * 0 deploy cd /srv/researchmate && infrastructure/scripts/verify-backup.sh "$(ls -1dt /srv/researchmate-backups/researchmate-* | head -1)" >> /var/log/researchmate-backup.log 2>&1
```

**Verify** a backup without touching the live data. The script checks the checksums, decrypts if needed, restores into a temporary database, checks migration history and core tables, confirms every stored file the database references is in the archive, then drops the temporary database:

```bash
infrastructure/scripts/verify-backup.sh /srv/researchmate-backups/researchmate-<timestamp>
# on another machine with local client tools:
VERIFY_ADMIN_URL=postgres://user:pass@host:5432/postgres infrastructure/scripts/verify-backup.sh <dir>
```

Also back up `.env` (it contains `ENCRYPTION_KEY`; without it stored API keys, Drive tokens and 2FA secrets can't be decrypted) separately and securely.

Restore (destructive; decrypt `*.gpg` first if encrypted):

```bash
infrastructure/scripts/restore.sh /srv/researchmate-backups/researchmate-<timestamp>
```

## 7. Operations

- Health: `GET /api/health` returns `200` with database, Redis, storage and worker checks, `503` if the database, Redis or storage is failing. Docker health checks use it for the web container; worker containers are healthy while they refresh their heartbeat.
- Logs: `docker compose logs -f researchmate-web researchmate-worker researchmate-scheduler` (JSON lines).
- Plans: change prices/limits in the `plans` and `plan_entitlements` tables; `migrate` never overwrites edited values.
- Assigning a plan to an organization (until online billing exists):

  ```sql
  begin;
  update subscriptions set status = 'canceled', updated_at = now()
   where organization_id = '<org-id>' and status in ('active','trialing','past_due');
  insert into subscriptions (organization_id, plan_id, status, provider)
   select '<org-id>', id, 'active', 'manual' from plans where key = 'research_pro';
  commit;
  ```

- Per-organization feature grant (e.g. Google Drive for a Free org):

  ```sql
  insert into organization_entitlement_overrides (organization_id, feature_key, value, reason)
  values ('<org-id>', 'integrations.google_drive', 'true', 'pilot programme');
  ```

## 8. Monitoring

`GET /api/metrics` serves Prometheus metrics to holders of `METRICS_TOKEN` (and 404s when it's unset). Nginx blocks the path from the internet, so it is only reachable inside the Docker network. It reports counts only (no names, emails or content):
- whether dependencies are up, the worker heartbeat, and queue depth by state;
- pending and failed notification emails, the age of the oldest pending export, AI runs, payments, and failed sign-ins in the last hour;
- stored bytes, process memory and uptime.

```bash
docker compose --profile monitoring up -d     # Prometheus on 127.0.0.1:9090
ssh -L 9090:127.0.0.1:9090 your-server         # then open http://localhost:9090/alerts
```

Alert rules are in `infrastructure/monitoring/alerts.yml`:
- app down or dependency down;
- worker missing;
- queue backlog, or failed jobs growing;
- notification email or document exports stuck;
- spikes in payment failures or sign-in failures;
- high memory.

To be paged, add Alertmanager (or point Grafana at Prometheus). An external uptime check on `/api/health` covers the case where the whole server is down.

## 9. Malware scanning (optional)

```bash
docker compose --profile clamav up -d clamav   # first start downloads signatures (several minutes)
# .env: CLAMAV_HOST=clamav
docker compose up -d researchmate-web researchmate-worker
```

Every upload is streamed to clamd before it is committed. Infected files are refused and deleted, and the quota is returned. While the scanner is unreachable, uploads are refused with a "try again shortly" message (fail closed). ClamAV keeps its signature database in memory: allow 1–2 GB of RAM for it.

## 10. Data retention and deletion

- **Deleted files** stop counting against quota at once. Stored objects are purged after `FILE_RETENTION_HOURS` (default 72).
- **Deleting a workspace** (Settings → Organization, owner only, password required):
  - everyone loses access immediately;
  - the owner can restore it from Settings → Profile for 30 days;
  - after that, the nightly purge deletes its projects, files, documents, notes, credentials and memberships, including stored objects;
  - invoices, payments and the credit ledger are copied to `retained_financial_records` for accounting, and are immutable there. Remove them only after your legal retention period: `delete from retained_financial_records where purged_at < now() - interval '7 years';` (adjust to your jurisdiction).
- **Deleting an account** (Settings → Profile):
  - ends memberships;
  - removes sessions, 2FA secrets, API keys, Drive tokens and notifications;
  - schedules the user's solo workspaces for deletion;
  - pseudonymises the user record (email and name replaced), so audit trails stay intact without identifying the person. It's refused while the user owns a workspace with other members.
- **Security and audit logs** are kept with the organization and removed when it is purged. Sessions and spent tokens are cleaned daily.
