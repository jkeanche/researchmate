#!/usr/bin/env bash
# Restores a backup produced by backup.sh. DESTRUCTIVE: replaces the current
# database and research files.
#
#   infrastructure/scripts/restore.sh backups/researchmate-20261101T000000Z
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a

SRC="${1:?usage: restore.sh <backup-dir>}"
(cd "$SRC" && sha256sum -c SHA256SUMS)

read -r -p "This replaces the current database and files with $SRC. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "Aborted."; exit 1; }

docker compose stop researchmate-web researchmate-worker

echo "Restoring database..."
docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-researchmate}" -d "${POSTGRES_DB:-researchmate}" --clean --if-exists --no-owner < "$SRC/database.dump"

echo "Restoring research files..."
docker compose run --rm --no-deps -v "$(cd "$SRC" && pwd)":/backup:ro --entrypoint sh researchmate-worker \
  -c "rm -rf /var/lib/researchmate/files /var/lib/researchmate/generated && tar -C /var/lib/researchmate -xzf /backup/files.tar.gz"

docker compose run --rm migrate
docker compose start researchmate-web researchmate-worker
echo "Restore complete."
