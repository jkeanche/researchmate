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
- `EMAIL_*` → your SMTP provider (required in production)

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

Schedule it daily (cron) and **copy backups off the server** (e.g. `rclone` to object storage). A backup on the same disk does not protect against disk loss. Also back up `.env` (it contains `ENCRYPTION_KEY`) separately and securely.

Restore (destructive):

```bash
infrastructure/scripts/restore.sh /srv/researchmate-backups/researchmate-<timestamp>
```

Test a restore on a staging machine at least once.

## 7. Operations

- Health: `GET /api/health` returns `200` with database, Redis and storage checks, `503` if degraded. Docker health checks use it.
- Logs: `docker compose logs -f researchmate-web researchmate-worker` (JSON lines).
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
