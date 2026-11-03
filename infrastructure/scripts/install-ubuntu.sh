#!/usr/bin/env bash
# =============================================================================
# ResearchMate AI — install or upgrade on Ubuntu 22.04 / 24.04 without Docker,
# using the server's own Nginx, PostgreSQL and Redis.
#
#   sudo infrastructure/scripts/install-ubuntu.sh --domain research.example.org \
#        --email you@example.org --tls \
#        --smtp-host smtp.example.org --smtp-user apikey --mail-from "ResearchMate <no-reply@example.org>"
#
# Run it from a checkout of the repository. Running it again upgrades: the new
# code is built into a fresh release directory, migrations run, and the
# services switch over. Settings and secrets in the env file are kept.
#
# What it sets up
#   packages   Node.js 22, Redis, PostgreSQL and Nginx (when missing), LibreOffice,
#              Tesseract, Poppler and fonts for document rendering and OCR
#   user       system user "researchmate" (no login shell)
#   files      /opt/researchmate/releases/<time>  code, one directory per release
#              /opt/researchmate/current          symlink to the live release
#              /var/lib/researchmate              research files (back this up)
#              /etc/researchmate/researchmate.env settings and secrets (root:researchmate 0640)
#              /var/backups/researchmate          daily backups
#   database   PostgreSQL role and database "researchmate" (password generated)
#   services   researchmate-web, researchmate-worker@jobs, researchmate-worker@scheduler,
#              researchmate-backup.timer (systemd)
#   nginx      /etc/nginx/sites-available/researchmate (+ Let's Encrypt with --tls)
#
# Options
#   --domain NAME          public host name (required on first install)
#   --email ADDRESS        contact for Let's Encrypt (required with --tls)
#   --tls                  obtain and renew a Let's Encrypt certificate (certbot)
#   --cert FILE --key FILE use an existing certificate instead of --tls
#   --smtp-host HOST       SMTP server (required: sign-up and password emails)
#   --smtp-port PORT       default 587
#   --smtp-user USER       SMTP user name
#   --smtp-password-file F read the SMTP password from a file (or set SMTP_PASSWORD
#                          in the environment); kept out of the process list
#   --mail-from "Name <a@b>"  sender address
#   --admin-email ADDRESS  create (or promote) a platform administrator; the
#                          password is asked for, or read from ADMIN_PASSWORD
#   --admin-name NAME      display name for a new administrator
#   --database-url URL     use an existing database instead of creating one
#   --db-name NAME         database and role name to create (default researchmate)
#   --redis-url URL        default redis://127.0.0.1:6379/0
#   --port PORT            port the app listens on, on 127.0.0.1 (default 3000)
#   --app-dir DIR          default /opt/researchmate
#   --data-dir DIR         default /var/lib/researchmate
#   --swap SIZE            create a swap file (e.g. 2G) when the server has none;
#                          building needs about 3 GB of memory
#   --skip-packages        don't install or upgrade system packages
#   --no-start             set everything up but don't (re)start the services
#   -h, --help             show this help
# =============================================================================
set -Eeuo pipefail

# ----------------------------------------------------------------------------- output
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '    %s! %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

usage() { sed -n '2,/^# =====/p' "$0" | sed 's/^# \{0,1\}//; /^=====/d'; exit 0; }

# ----------------------------------------------------------------------------- arguments
DOMAIN="" LE_EMAIL="" TLS=0 CERT="" KEY=""
SMTP_HOST="" SMTP_PORT="" SMTP_USER="" SMTP_PASSWORD_FILE="" MAIL_FROM=""
ADMIN_EMAIL="" ADMIN_NAME=""
DATABASE_URL_ARG="" DB_NAME="researchmate" REDIS_URL_ARG="" PORT="3000"
APP_DIR="/opt/researchmate" DATA_DIR="/var/lib/researchmate" SWAP=""
SKIP_PACKAGES=0 NO_START=0
APP_USER="researchmate"
ENV_DIR="/etc/researchmate"
ENV_FILE="$ENV_DIR/researchmate.env"
BACKUP_DIR="/var/backups/researchmate"
PNPM_VERSION="10.28.0"
NODE_MAJOR=22

need_value() { [ -n "${2:-}" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_value "$1" "${2:-}"; DOMAIN="$2"; shift 2 ;;
    --email) need_value "$1" "${2:-}"; LE_EMAIL="$2"; shift 2 ;;
    --tls) TLS=1; shift ;;
    --cert) need_value "$1" "${2:-}"; CERT="$2"; shift 2 ;;
    --key) need_value "$1" "${2:-}"; KEY="$2"; shift 2 ;;
    --smtp-host) need_value "$1" "${2:-}"; SMTP_HOST="$2"; shift 2 ;;
    --smtp-port) need_value "$1" "${2:-}"; SMTP_PORT="$2"; shift 2 ;;
    --smtp-user) need_value "$1" "${2:-}"; SMTP_USER="$2"; shift 2 ;;
    --smtp-password-file) need_value "$1" "${2:-}"; SMTP_PASSWORD_FILE="$2"; shift 2 ;;
    --mail-from) need_value "$1" "${2:-}"; MAIL_FROM="$2"; shift 2 ;;
    --admin-email) need_value "$1" "${2:-}"; ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-name) need_value "$1" "${2:-}"; ADMIN_NAME="$2"; shift 2 ;;
    --database-url) need_value "$1" "${2:-}"; DATABASE_URL_ARG="$2"; shift 2 ;;
    --db-name) need_value "$1" "${2:-}"; DB_NAME="$2"; shift 2 ;;
    --redis-url) need_value "$1" "${2:-}"; REDIS_URL_ARG="$2"; shift 2 ;;
    --port) need_value "$1" "${2:-}"; PORT="$2"; shift 2 ;;
    --app-dir) need_value "$1" "${2:-}"; APP_DIR="${2%/}"; shift 2 ;;
    --data-dir) need_value "$1" "${2:-}"; DATA_DIR="${2%/}"; shift 2 ;;
    --swap) need_value "$1" "${2:-}"; SWAP="$2"; shift 2 ;;
    --skip-packages) SKIP_PACKAGES=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ----------------------------------------------------------------------------- preflight
step "Checking the server"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 …)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$SRC/pnpm-workspace.yaml" ] && [ -d "$SRC/apps/web" ] || die "run this script from a ResearchMate checkout ($SRC isn't one)"
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04) ok "Ubuntu $VERSION_ID" ;;
  ubuntu:*) warn "Ubuntu $VERSION_ID hasn't been tested; continuing" ;;
  *) die "this installer supports Ubuntu 22.04 and 24.04 (found ${PRETTY_NAME:-unknown})" ;;
esac
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "--db-name must be lower-case letters, digits and underscores"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "--port must be a number"
[ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain must be a host name like research.example.org"
if [ -n "$CERT$KEY" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || die "--cert and --key go together"
  [ "$TLS" -eq 0 ] || die "use either --tls or --cert/--key, not both"
  [ -r "$CERT" ] && [ -r "$KEY" ] || die "can't read $CERT or $KEY"
fi
[ "$TLS" -eq 0 ] || [ -n "$LE_EMAIL" ] || die "--tls needs --email (Let's Encrypt sends expiry warnings there)"
FIRST_INSTALL=1; [ -f "$ENV_FILE" ] && FIRST_INSTALL=0
if [ "$FIRST_INSTALL" -eq 1 ] && [ -z "$DOMAIN" ]; then die "--domain is required on the first install"; fi

mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
info "memory ${mem_mb} MB, swap ${swap_mb} MB, free disk $(df -h --output=avail / | tail -1 | tr -d ' ')"
if [ -n "$SWAP" ] && [ "$swap_mb" -eq 0 ]; then
  [ -e /swapfile ] && die "/swapfile already exists but isn't active; check it first"
  fallocate -l "$SWAP" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "created a $SWAP swap file"
elif [ $((mem_mb + swap_mb)) -lt 3000 ]; then
  warn "building needs about 3 GB of memory; this server has $((mem_mb + swap_mb)) MB including swap. Re-run with --swap 2G if the build is killed."
fi

# ----------------------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
if [ "$SKIP_PACKAGES" -eq 0 ]; then
  step "Installing system packages"
  apt-get update -qq
  pkgs=(ca-certificates curl gnupg rsync openssl redis-server postgresql-client
        poppler-utils tesseract-ocr tesseract-ocr-eng libreoffice-writer-nogui python3-uno
        fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core)
  command -v nginx >/dev/null || pkgs+=(nginx)
  # A local PostgreSQL server unless an external database URL was given (or one is already installed).
  if [ -z "$DATABASE_URL_ARG" ] && ! command -v pg_ctlcluster >/dev/null; then pkgs+=(postgresql); fi
  [ "$TLS" -eq 0 ] || pkgs+=(certbot)
  apt-get install -y -qq --no-install-recommends "${pkgs[@]}" >/dev/null
  ok "packages installed"

  node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
  if [ "${node_major:-0}" -lt "$NODE_MAJOR" ]; then
    info "installing Node.js $NODE_MAJOR (NodeSource)"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
  fi
else
  step "Skipping system packages (--skip-packages)"
fi
NODE_BIN="$(command -v node)" || die "Node.js $NODE_MAJOR is required"
node_major=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
[ "$node_major" -ge "$NODE_MAJOR" ] || die "Node.js $NODE_MAJOR or newer is required (found $(node -v))"
COREPACK_BIN="$(dirname "$NODE_BIN")/corepack"
[ -x "$COREPACK_BIN" ] || COREPACK_BIN="$(command -v corepack || true)"
[ -x "$COREPACK_BIN" ] || die "corepack (bundled with Node.js) wasn't found next to $NODE_BIN"
command -v nginx >/dev/null || die "Nginx isn't installed"
command -v redis-cli >/dev/null || die "Redis isn't installed"
ok "Node.js $(node -v), $(nginx -v 2>&1 | sed 's|.*/||; s|^|Nginx |'), $(redis-server --version | awk '{print $1, $3}' | tr -d 'v=')"

# ----------------------------------------------------------------------------- user and directories
step "Creating the service user and directories"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --user-group "$APP_USER"
  ok "created user $APP_USER"
fi
install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$APP_DIR/releases"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$BACKUP_DIR"
install -d -m 0750 -o root -g "$APP_USER" "$ENV_DIR"
ok "$APP_DIR (code), $DATA_DIR (research files), $BACKUP_DIR (backups)"

# ----------------------------------------------------------------------------- services we depend on
step "Checking Redis and PostgreSQL"
systemctl_ok() { command -v systemctl >/dev/null && [ -d /run/systemd/system ]; }
if systemctl_ok; then systemctl enable --now redis-server >/dev/null 2>&1 || true; fi
REDIS_URL="${REDIS_URL_ARG:-redis://127.0.0.1:6379/0}"
redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 || die "Redis at $REDIS_URL isn't answering"
policy=$(redis-cli -u "$REDIS_URL" config get maxmemory-policy 2>/dev/null | tail -1 || true)
if [ -n "$policy" ] && [ "$policy" != "noeviction" ]; then
  warn "Redis maxmemory-policy is '$policy'; the job queues need 'noeviction' (set it in /etc/redis/redis.conf)"
fi
ok "Redis answers at $REDIS_URL"

# ----------------------------------------------------------------------------- env file helpers
# Values are written single-quoted, which both systemd's EnvironmentFile and
# bash read literally. A value containing a single quote can't be represented.
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1='\(.*\)'\$/\1/p; s/^$1=\([^'].*\)\$/\1/p" "$ENV_FILE" | tail -1 || true; }
env_set() {
  local k="$1" v="$2"
  case "$v" in *"'"*) die "the value for $k can't contain a single quote"; esac
  case "$v" in *$'\n'*) die "the value for $k can't contain a line break"; esac
  # Shell builtins only (printf, redirection), so secrets never appear in a process's arguments.
  local tmp; tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then grep -v "^$k=" "$ENV_FILE" > "$tmp" || true; fi
  printf "%s='%s'\n" "$k" "$v" >> "$tmp"
  install -m 0640 -o root -g "$APP_USER" "$tmp" "$ENV_FILE"; rm -f "$tmp"
}
env_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }

# ----------------------------------------------------------------------------- database
if [ -n "$DATABASE_URL_ARG" ]; then
  DATABASE_URL="$DATABASE_URL_ARG"
  ok "using the database you gave"
elif [ -n "$(env_get DATABASE_URL)" ]; then
  DATABASE_URL="$(env_get DATABASE_URL)"
  ok "using the database from $ENV_FILE"
else
  if systemctl_ok; then systemctl enable --now postgresql >/dev/null 2>&1 || true; fi
  runuser -u postgres -- psql -Atqc 'select 1' >/dev/null 2>&1 || die "can't reach the local PostgreSQL server as the postgres user (is it running?)"
  DB_PASSWORD="$(openssl rand -hex 24)"
  # The password goes in through stdin (\set), never on a command line.
  runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
\set pw '$DB_PASSWORD'
\set role '$DB_NAME'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', :'role', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'role') \gexec
SQL
  DATABASE_URL="postgres://$DB_NAME:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME"
  ok "PostgreSQL role and database '$DB_NAME' ready"
fi

# ----------------------------------------------------------------------------- settings
step "Writing settings to $ENV_FILE"
if [ "$FIRST_INSTALL" -eq 1 ]; then
  install -m 0640 -o root -g "$APP_USER" /dev/null "$ENV_FILE"
  {
    echo "# ResearchMate settings. Read by systemd (EnvironmentFile) and the scripts."
    echo "# Values are single-quoted. Restart the services after editing:"
    echo "#   systemctl restart researchmate-web researchmate-worker@jobs researchmate-worker@scheduler"
    echo "# All options: .env.example in the repository."
  } > "$ENV_FILE"
fi
env_set DATABASE_URL "$DATABASE_URL"
env_set REDIS_URL "$REDIS_URL"
[ -z "$DOMAIN" ] || env_set APP_URL "https://$DOMAIN"
env_default APP_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
env_default ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
env_default METRICS_TOKEN "$(openssl rand -hex 24)"
env_default STORAGE_DRIVER local
env_set LOCAL_STORAGE_ROOT "$DATA_DIR"
env_default MAX_UPLOAD_SIZE_MB 100
env_default REQUIRE_EMAIL_VERIFICATION true
env_default WORKER_CONCURRENCY 4
env_default OCR_ENABLED true
[ -z "$SMTP_HOST" ] || env_set EMAIL_HOST "$SMTP_HOST"
[ -z "$SMTP_PORT" ] || env_set EMAIL_PORT "$SMTP_PORT"
env_default EMAIL_PORT 587
[ -z "$SMTP_USER" ] || env_set EMAIL_USERNAME "$SMTP_USER"
if [ -n "$SMTP_PASSWORD_FILE" ]; then env_set EMAIL_PASSWORD "$(head -n1 "$SMTP_PASSWORD_FILE")"
elif [ -n "${SMTP_PASSWORD:-}" ]; then env_set EMAIL_PASSWORD "$SMTP_PASSWORD"; fi
[ -z "$MAIL_FROM" ] || env_set EMAIL_FROM "$MAIL_FROM"
[ -n "$(env_get EMAIL_FROM)" ] || env_set EMAIL_FROM "ResearchMate <no-reply@${DOMAIN:-localhost}>"
DOMAIN="${DOMAIN:-$(env_get APP_URL | sed -E 's#^https?://##; s#/.*##')}"
if [ "$FIRST_INSTALL" -eq 1 ]; then ok "settings written with newly generated secrets"; else ok "settings updated (existing secrets kept)"; fi
[ "$FIRST_INSTALL" -eq 0 ] || warn "back up $ENV_FILE somewhere safe: ENCRYPTION_KEY can't be recovered, and without it stored API keys, Drive tokens and 2FA secrets are unreadable"

# Runs a command as the service user: as_user without the settings (installs and
# builds don't need secrets), as_app with the settings loaded.
# Proxy and CA settings pass through, for servers that reach npm via a proxy.
PASS_ENV=()
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  if [ -n "${!v:-}" ]; then PASS_ENV+=("$v=${!v}"); fi
done
as_user() {
  runuser -u "$APP_USER" -- env -i HOME="$APP_DIR" PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME="$APP_DIR/.cache/corepack" NEXT_TELEMETRY_DISABLED=1 \
    ${PASS_ENV[@]+"${PASS_ENV[@]}"} "$@"
}
as_app() { as_user bash -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV_FILE" "$@"; }

# ----------------------------------------------------------------------------- nginx
# Before the build: certificate and Nginx problems fail fast, before any code or
# database change.
step "Configuring Nginx for $DOMAIN"
NGINX_SITE=/etc/nginx/sites-available/researchmate
ACME_ROOT=/var/www/letsencrypt
install -d -m 0755 "$ACME_ROOT"
nginx_ver="$(nginx -v 2>&1 | sed -E 's#.*/([0-9.]+).*#\1#')"
# "http2 on;" exists from Nginx 1.25.1; older versions (Ubuntu 22.04: 1.18, 24.04: 1.24) use "listen … http2".
if printf '%s\n%s\n' "1.25.1" "$nginx_ver" | sort -V -C; then H2_LISTEN=""; H2_LINE="    http2 on;"; else H2_LISTEN=" http2"; H2_LINE=""; fi
BODY_MB=$(( $(env_get MAX_UPLOAD_SIZE_MB) + 10 ))
# IPv6 listeners only when the kernel has IPv6 (otherwise Nginx refuses to start).
HAS_IPV6=0; [ -f /proc/net/if_inet6 ] && HAS_IPV6=1

proxy_block() {
  cat <<EOF
    server_tokens off;
    # Uploads stream straight to the app, which enforces plan limits.
    client_max_body_size ${BODY_MB}m;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    limit_req_status 429;

    # Metrics are for local scraping only (curl -H "Authorization: Bearer …" http://127.0.0.1:$PORT/api/metrics).
    location = /api/metrics { return 404; }
    location ~ ^/(login|register|forgot-password|reset-password|verify-email) {
        limit_req zone=researchmate_auth burst=20 nodelay;
        proxy_pass http://researchmate_web;
    }
    location /_next/static/ {
        proxy_pass http://researchmate_web;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location / {
        limit_req zone=researchmate_general burst=60 nodelay;
        proxy_pass http://researchmate_web;
    }
EOF
}
write_site() { # $1 = mode: acme-only | tls | plain
  {
    echo "# ResearchMate — written by install-ubuntu.sh; re-running the installer rewrites it."
    echo "limit_req_zone \$binary_remote_addr zone=researchmate_auth:10m rate=10r/m;"
    echo "limit_req_zone \$binary_remote_addr zone=researchmate_general:10m rate=20r/s;"
    echo "upstream researchmate_web { server 127.0.0.1:$PORT; keepalive 32; }"
    echo
    echo "server {"
    echo "    listen 80;"
    [ "$HAS_IPV6" -eq 0 ] || echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    echo "    location /.well-known/acme-challenge/ { root $ACME_ROOT; }"
    if [ "$1" = plain ]; then proxy_block; else echo "    location / { return 301 https://\$host\$request_uri; }"; fi
    echo "}"
    if [ "$1" = tls ]; then
      echo
      echo "server {"
      echo "    listen 443 ssl$H2_LISTEN;"
      [ "$HAS_IPV6" -eq 0 ] || echo "    listen [::]:443 ssl$H2_LISTEN;"
      [ -z "$H2_LINE" ] || echo "$H2_LINE"
      echo "    server_name $DOMAIN;"
      echo "    ssl_certificate     $SSL_CERT;"
      echo "    ssl_certificate_key $SSL_KEY;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_prefer_server_ciphers off;"
      echo "    ssl_session_cache shared:researchmate_ssl:10m;"
      echo "    ssl_session_timeout 1d;"
      echo "    location /.well-known/acme-challenge/ { root $ACME_ROOT; }"
      proxy_block
      echo "}"
    fi
  } > "$NGINX_SITE.new"
  # Keep the previous working file so a failed test can put it back.
  local had_previous=0
  if [ -f "$NGINX_SITE" ]; then cp -p "$NGINX_SITE" "$NGINX_SITE.previous"; had_previous=1; fi
  mv "$NGINX_SITE.new" "$NGINX_SITE"
  ln -sfn "$NGINX_SITE" /etc/nginx/sites-enabled/researchmate
  if ! nginx -t >/dev/null 2>&1; then
    { nginx -t 2>&1 || true; } | sed 's/^/    /' >&2
    if [ "$had_previous" -eq 1 ] && mv "$NGINX_SITE.previous" "$NGINX_SITE" && nginx -t >/dev/null 2>&1; then
      die "the new Nginx configuration failed its test; the previous ResearchMate configuration was put back (still serving)"
    fi
    rm -f /etc/nginx/sites-enabled/researchmate
    die "the Nginx configuration test failed; the ResearchMate site was disabled so other sites keep working"
  fi
  rm -f "$NGINX_SITE.previous"
  if systemctl_ok; then systemctl reload nginx 2>/dev/null || systemctl restart nginx; elif [ -f /run/nginx.pid ]; then nginx -s reload; fi
}

SSL_CERT="" SSL_KEY=""
if [ -n "$CERT" ]; then
  SSL_CERT="$CERT" SSL_KEY="$KEY"
elif [ "$TLS" -eq 1 ] || [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    write_site acme-only
    info "requesting a Let's Encrypt certificate for $DOMAIN (DNS must already point here, port 80 open)"
    certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --email "$LE_EMAIL" --agree-tos --non-interactive --keep-until-expiring \
      || die "certbot couldn't get a certificate; check that $DOMAIN points to this server and port 80 is reachable"
  fi
  SSL_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem" SSL_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  install -d /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi
if [ -n "$SSL_CERT" ]; then
  write_site tls
  ok "https://$DOMAIN (certificate $SSL_CERT)"
else
  write_site plain
  warn "no certificate: Nginx serves plain HTTP. The app requires https in the browser, so put a TLS proxy in front, or re-run with --tls."
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null && ok "firewall: allowed HTTP and HTTPS"
fi

# ----------------------------------------------------------------------------- build a release
step "Building the application"
STAMP="$(date -u +%Y%m%d%H%M%S)"
REV="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo src)"
REL="$APP_DIR/releases/$STAMP-$REV"
install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$REL"
rsync -a --delete --exclude node_modules --exclude .next --exclude .git --exclude '.env' --exclude '.env.*' \
  --exclude 'test-results' --exclude 'dump.rdb' "$SRC/" "$REL/"
cp "$SRC/.env.example" "$REL/.env.example"
chown -R "$APP_USER:$APP_USER" "$REL"
info "release $REL"
as_user bash -c "cd '$REL' && '$COREPACK_BIN' pnpm@$PNPM_VERSION install --frozen-lockfile --prefer-offline >/dev/null"
ok "dependencies installed"
as_user bash -c "cd '$REL' && NODE_ENV=production '$COREPACK_BIN' pnpm@$PNPM_VERSION --filter @researchmate/web build" > "$REL/build.log" 2>&1 \
  || { tail -30 "$REL/build.log" >&2; die "the build failed (full log: $REL/build.log). If it was killed, add memory or --swap 2G."; }
STANDALONE="$REL/apps/web/.next/standalone"
[ -f "$STANDALONE/apps/web/server.js" ] || die "the build didn't produce $STANDALONE/apps/web/server.js"
cp -r "$REL/apps/web/.next/static" "$STANDALONE/apps/web/.next/static"
[ ! -d "$REL/apps/web/public" ] || cp -r "$REL/apps/web/public" "$STANDALONE/apps/web/public"
chown -R "$APP_USER:$APP_USER" "$REL"
ok "web app built"

# ----------------------------------------------------------------------------- migrations
step "Updating the database"
as_app bash -c "cd '$REL' && '$COREPACK_BIN' pnpm@$PNPM_VERSION --silent db:migrate" | sed 's/^/    /'
ok "migrations applied and reference data synchronised"

# ----------------------------------------------------------------------------- switch release
ln -sfn "$REL" "$APP_DIR/current.new" && mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
# Keep the three newest releases for quick rollback.
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
ok "now serving $(basename "$REL") (rollback: ln -sfn <older release> $APP_DIR/current, then restart)"

# ----------------------------------------------------------------------------- systemd
step "Installing services"
render() {
  sed -e "s|@USER@|$APP_USER|g" -e "s|@ENV_FILE@|$ENV_FILE|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
      -e "s|@NODE@|$NODE_BIN|g" -e "s|@PORT@|$PORT|g" -e "s|@BACKUP_DIR@|$BACKUP_DIR|g" "$1"
}
for unit in researchmate-web.service researchmate-worker@.service researchmate-backup.service researchmate-backup.timer; do
  render "$REL/infrastructure/systemd/$unit" > "/etc/systemd/system/$unit"
done
ok "units in /etc/systemd/system"

# ----------------------------------------------------------------------------- start
if [ "$NO_START" -eq 1 ]; then
  step "Not starting services (--no-start)"
elif ! systemctl_ok; then
  step "systemd isn't running here; services were installed but not started"
else
  step "Starting services"
  [ -n "$(env_get EMAIL_HOST)" ] || die "EMAIL_HOST is empty: set your SMTP server with --smtp-host (or edit $ENV_FILE) and re-run. Production refuses to start without email."
  systemctl daemon-reload
  systemctl enable researchmate-web researchmate-worker@jobs researchmate-worker@scheduler researchmate-backup.timer >/dev/null 2>&1
  systemctl restart researchmate-worker@jobs researchmate-worker@scheduler researchmate-web
  systemctl start researchmate-backup.timer
  info "waiting for the app"
  healthy=0
  for _ in $(seq 1 45); do
    if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null; then healthy=1; break; fi
    sleep 2
  done
  if [ "$healthy" -eq 1 ]; then
    ok "health: $(curl -s "http://127.0.0.1:$PORT/api/health")"
  else
    journalctl -u researchmate-web -n 30 --no-pager >&2 || true
    die "the web app didn't become healthy; see: journalctl -u researchmate-web -u 'researchmate-worker@*'"
  fi
fi

# ----------------------------------------------------------------------------- administrator
if [ -n "$ADMIN_EMAIL" ]; then
  step "Platform administrator"
  if [ -z "${ADMIN_PASSWORD:-}" ] && [ -t 0 ]; then
    read -r -s -p "    Password for $ADMIN_EMAIL (at least 10 characters; leave empty to keep an existing account's): " ADMIN_PASSWORD; echo
  fi
  # The password reaches the admin script through a private file read by a shell
  # builtin, so it never appears in a process's arguments.
  PW_FILE="$(mktemp "$APP_DIR/.admin-password.XXXXXX")"
  printf '%s' "${ADMIN_PASSWORD:-}" > "$PW_FILE"
  chown "$APP_USER" "$PW_FILE"; chmod 0600 "$PW_FILE"
  as_app env ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_NAME="${ADMIN_NAME:-Administrator}" bash -c \
    'ADMIN_PASSWORD="$(< "$0")"; export ADMIN_PASSWORD; rm -f "$0"; cd "$1" && exec "$2" --import tsx src/scripts/create-admin.ts' \
    "$PW_FILE" "$APP_DIR/current/apps/worker" "$NODE_BIN" </dev/null | sed 's/^/    /' \
    || { rm -f "$PW_FILE"; die "creating the administrator failed (see the message above)"; }
  rm -f "$PW_FILE"
fi

# ----------------------------------------------------------------------------- summary
step "Done"
cat <<EOF
    Site          https://$DOMAIN
    Settings      $ENV_FILE
    Code          $APP_DIR/current -> $(readlink "$APP_DIR/current")
    Files         $DATA_DIR
    Backups       $BACKUP_DIR (daily, researchmate-backup.timer)
    Logs          journalctl -u researchmate-web -u 'researchmate-worker@*' -f
    Upgrade       git pull && sudo $0
EOF
[ -n "$ADMIN_EMAIL" ] || echo "    Admin         sudo $0 --skip-packages --admin-email you@example.org"
