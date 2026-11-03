# Installing on Ubuntu with Nginx and PostgreSQL (no Docker)

This guide installs ResearchMate directly on an Ubuntu server, using the server's own Nginx, PostgreSQL and Redis. One script does the work: `infrastructure/scripts/install-ubuntu.sh`. Running it again later upgrades the site. (To run everything in containers instead, see [ubuntu-vps.md](ubuntu-vps.md).)

## What you need

- **Server:** Ubuntu 22.04 or 24.04, at least 2 CPU cores, 4 GB of RAM and 40 GB of disk (more for research files).
  - With 2 GB of RAM, add `--swap 2G`: building the app needs about 3 GB.
  - If Nginx, PostgreSQL or Redis are already running, the script uses them. Otherwise it installs them.
- **Domain:** a name such as `research.example.org`, with a DNS **A** (and **AAAA**, if you use IPv6) record pointing at the server.
- **Email (SMTP) account:** for sign-up, password-reset and notification emails, e.g. your institution's mail server, Amazon SES, Mailgun, Postmark or Brevo. You need the host, port, user name and password, and a sender address.
- **Firewall:** ports **80** and **443** open to the internet, and SSH for you.
- **Access:** root access (`sudo`).

## 1. Prepare the server

```bash
sudo apt-get update && sudo apt-get install -y git
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable   # if you use ufw
```

Put the code on the server. Either clone your repository:

```bash
git clone <your-repository-url> ~/researchmate
cd ~/researchmate
```

or copy the bundle file and check it out:

```bash
scp researchmate.bundle you@server:~/
git clone ~/researchmate.bundle ~/researchmate && cd ~/researchmate
```

Keep this checkout: it's where future upgrades come from. The running copy lives in `/opt/researchmate`.

Save your SMTP password in a file only root can read, so it never appears in your shell history or the process list:

```bash
sudo install -m 600 /dev/null /root/smtp-password && sudo nano /root/smtp-password   # paste the password, save
```

## 2. Run the installer

```bash
sudo infrastructure/scripts/install-ubuntu.sh \
  --domain research.example.org \
  --email you@example.org --tls \
  --smtp-host smtp.example.org --smtp-port 587 --smtp-user apikey \
  --smtp-password-file /root/smtp-password \
  --mail-from "ResearchMate <no-reply@research.example.org>" \
  --admin-email you@example.org --admin-name "Your Name"
```

It asks for the administrator's password (at least 10 characters), then runs on its own for a few minutes, printing each step:
- system packages;
- the `researchmate` user and directories;
- the database;
- settings with generated secrets;
- Nginx and the Let's Encrypt certificate;
- build, database migrations, services, health check.

At the end it prints where everything is. Then open `https://research.example.org` and sign in as the administrator.

### Options

| Option | Meaning |
|---|---|
| `--domain NAME` | Public host name. Required the first time. |
| `--tls` + `--email ADDRESS` | Get a free Let's Encrypt certificate; it renews automatically, and Nginx reloads after each renewal. The DNS record must already point at the server. |
| `--cert FILE --key FILE` | Use a certificate you already have, instead of `--tls`. |
| `--smtp-host`, `--smtp-port`, `--smtp-user`, `--smtp-password-file`, `--mail-from` | Email settings. The app won't start without `--smtp-host`. |
| `--admin-email`, `--admin-name` | Create a platform administrator, or promote an existing account. |
| `--database-url URL` | Use an existing PostgreSQL database (on this or another server) instead of creating one. |
| `--db-name NAME` | Name of the database and role to create (default `researchmate`). |
| `--redis-url URL` | Default `redis://127.0.0.1:6379/0`. |
| `--port PORT` | Local port the app listens on (default 3000). It is bound to 127.0.0.1 only. |
| `--app-dir`, `--data-dir` | Defaults `/opt/researchmate` and `/var/lib/researchmate`. |
| `--swap 2G` | Create a swap file if the server has none. |
| `--skip-packages` | Don't run `apt-get` (faster upgrades). |
| `--no-start` | Set everything up but don't restart the services. |

`sudo infrastructure/scripts/install-ubuntu.sh --help` prints the same list.

### If the server already runs other sites

The installer only adds what it needs and leaves the rest of the server alone:

- **Nginx:**
  - it adds one site, `/etc/nginx/sites-available/researchmate`, and enables it;
  - it doesn't change `nginx.conf`, other sites, or the default site;
  - its rate-limit zones are prefixed `researchmate_`, so they can't clash with yours;
  - every change is checked with `nginx -t` first. If the check fails, the previous ResearchMate configuration is restored, so your other sites keep working.
- **PostgreSQL:** it creates one role and one database with a random password and connects over `127.0.0.1`, which Ubuntu's default `pg_hba.conf` allows. It doesn't change server settings.
- **Redis:** it uses database 0 by default; pass `--redis-url redis://127.0.0.1:6379/3` to use another. The job queues need Redis's eviction policy to be `noeviction` (Ubuntu's default). The installer warns if yours differs.
- **Node.js:** it installs Node.js 22 from NodeSource only if `node` is missing or older.

## 3. What is where

| Path | Contents |
|---|---|
| `/etc/researchmate/researchmate.env` | All settings and secrets (owner root, group researchmate, mode 640). **Back this file up somewhere safe.** `ENCRYPTION_KEY` can't be recovered, and without it stored API keys, Drive tokens and 2FA secrets are unreadable. |
| `/opt/researchmate/current` | The live release: a link to `/opt/researchmate/releases/<time>-<commit>`. The three newest releases are kept. |
| `/var/lib/researchmate` | Uploaded research files and generated documents. |
| `/var/backups/researchmate` | Daily backups. |
| `/etc/systemd/system/researchmate-*` | The services. |

There are three services and a timer:
- `researchmate-web`: the app, on `127.0.0.1:3000`;
- `researchmate-worker@jobs`: email, text extraction, documents, AI, Drive and integrations;
- `researchmate-worker@scheduler`: deadline notices, renewals, purges, cleanup;
- `researchmate-backup.timer`: daily at about 02:15.

All services run as the unprivileged `researchmate` user, with a read-only system except `/var/lib/researchmate`.

## 4. Everyday commands

```bash
# Status and logs
systemctl status researchmate-web researchmate-worker@jobs researchmate-worker@scheduler
journalctl -u researchmate-web -u 'researchmate-worker@*' -f
curl -s http://127.0.0.1:3000/api/health      # {"status":"ok", … "worker":"ok"}

# After editing /etc/researchmate/researchmate.env
sudo systemctl restart researchmate-web researchmate-worker@jobs researchmate-worker@scheduler

# Another administrator
sudo infrastructure/scripts/install-ubuntu.sh --skip-packages --admin-email colleague@example.org
```

Optional features are switched on in the settings file; `.env.example` in the repository explains each one:
- Google Drive (`GOOGLE_CLIENT_ID`, …);
- platform AI (`PLATFORM_AI_*`, or the `DEFAULT_AI_*` / `OPENAI_API_KEY` style names);
- payments (`PAYSTACK_SECRET_KEY`, `PESAPAL_*`, `STRIPE_*`);
- Apify;
- malware scanning (`sudo apt-get install clamav-daemon`, then `CLAMAV_HOST='127.0.0.1'`).

Restart the services after changing them.

## 5. Upgrades and rollback

```bash
cd ~/researchmate && git pull
sudo infrastructure/scripts/install-ubuntu.sh --skip-packages
```

An upgrade:
1. builds the new version into a fresh release directory (the running site keeps serving meanwhile);
2. runs the database migrations;
3. switches the `current` link;
4. restarts the services and waits for the health check.

The settings and secrets are kept.

To roll back the code:

```bash
ls /opt/researchmate/releases/
sudo ln -sfn /opt/researchmate/releases/<previous> /opt/researchmate/current
sudo systemctl restart researchmate-web researchmate-worker@jobs researchmate-worker@scheduler
```

Migrations are forward-only and additive, so older code keeps working on the newer database. For anything more serious, restore a backup (section 6). Take one before each upgrade:

```bash
sudo systemctl start researchmate-backup && ls -t /var/backups/researchmate | head -1
```

## 6. Backups and restore

`researchmate-backup.timer` runs `backup-native.sh` every night. Each backup holds a database dump, an archive of the research files, and a checksum file. The last 14 are kept. In the settings file:
- `BACKUP_GPG_RECIPIENT` encrypts backups to a GPG public key; keep the private key off the server;
- `BACKUP_RCLONE_REMOTE` copies each backup to off-site storage. Set up the remote first with `sudo -u researchmate rclone config`. A backup on the same disk doesn't survive losing the disk.

**Verify** a backup regularly. This restores it into a temporary database, checks it, and confirms every stored file is in the archive:

```bash
cd /opt/researchmate/current
sudo VERIFY_LOCAL_POSTGRES=1 infrastructure/scripts/verify-backup.sh /var/backups/researchmate/researchmate-<time>
```

**Restore** (replaces the current data):

```bash
B=/var/backups/researchmate/researchmate-<time>     # decrypt *.gpg first if encrypted
sudo systemctl stop researchmate-web researchmate-worker@jobs researchmate-worker@scheduler
sudo bash -c 'set -a; . /etc/researchmate/researchmate.env; pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "'"$B"'/database.dump"'
sudo -u researchmate tar -C /var/lib/researchmate -xzf "$B/files.tar.gz"
sudo systemctl start researchmate-web researchmate-worker@jobs researchmate-worker@scheduler
```

On a new server, run the installer first, then put your saved `researchmate.env` back in `/etc/researchmate/` before restoring, so the `ENCRYPTION_KEY` matches the data.

## 7. Monitoring

- **Health:** `https://your-domain/api/health` for an external uptime monitor. It returns `200` when the database, Redis and storage are fine, and also reports whether a worker is alive.
- **Metrics:** Prometheus metrics at `http://127.0.0.1:3000/api/metrics`, with `Authorization: Bearer <METRICS_TOKEN>` (the token is in the settings file). Nginx blocks this path from the internet. Alert rules to reuse are in `infrastructure/monitoring/alerts.yml`.

## 8. Troubleshooting

| Problem | What to do |
|---|---|
| The build stops with "Killed" | Not enough memory: re-run with `--swap 2G`. |
| `certbot couldn't get a certificate` | Check the DNS record (`dig +short your-domain`) points at this server and port 80 is open, then re-run. |
| `EMAIL_HOST is empty` | Re-run with `--smtp-host …`, or set `EMAIL_HOST` in the settings file and restart. |
| 502 Bad Gateway | The app isn't running: `journalctl -u researchmate-web -n 50`. A settings problem is reported clearly at start-up. |
| Health shows `"worker":"missing"` | `systemctl status 'researchmate-worker@*'` and its journal. Emails, exports and text extraction wait until it runs. |
| `the new Nginx configuration failed its test` | The message above it says why (often a certificate path). The previous configuration was put back. |
| Sign-in doesn't stick | The site must be opened over **https**: the session cookie requires it. |

## How the installer was tested

It was run on Ubuntu 24.04 with PostgreSQL 16, Redis 7 and Nginx 1.24. Checked:
- a clean first install, and repeated runs as upgrades;
- secrets unchanged across runs;
- each service started from its unit file;
- health green through Nginx over HTTPS with HTTP/2;
- the administrator signs in, with a Secure, HttpOnly session cookie;
- a new user registers and the verification email arrives over SMTP;
- the metrics path is blocked publicly, static assets are cached for a year, and the sign-in rate limit returns 429;
- a backup is taken and verified by restoring it;
- an invalid certificate restores the previous Nginx configuration.

Not exercised there:
- **systemd itself:** the test machine had none. The unit files pass `systemd-analyze verify`.
- **Let's Encrypt:** no public DNS, so a self-signed certificate was used.
- **NodeSource:** Node.js 22 was already installed.
- **Ubuntu 22.04:** the script supports its older Nginx syntax, but it wasn't run there.
