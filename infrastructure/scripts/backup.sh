#!/usr/bin/env bash
# Backs up the database and research files from the Docker Compose stack.
#
#   infrastructure/scripts/backup.sh [backup-dir]     (default ./backups)
#
# Produces <dir>/researchmate-<timestamp>/{database.dump,files.tar.gz,SHA256SUMS}.
# Keeps the 14 most recent backups. Copy backups off the server regularly.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/researchmate-$STAMP"
mkdir -p "$OUT"

echo "Dumping database..."
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-researchmate}" -d "${POSTGRES_DB:-researchmate}" --format=custom --no-owner > "$OUT/database.dump"

echo "Archiving research files..."
docker compose run --rm --no-deps -v "$(cd "$OUT" && pwd)":/backup --entrypoint sh researchmate-worker \
  -c "tar -C /var/lib/researchmate -czf /backup/files.tar.gz files generated"

(cd "$OUT" && sha256sum database.dump files.tar.gz > SHA256SUMS)
echo "Backup written to $OUT"

ls -1dt "$DEST"/researchmate-* 2>/dev/null | tail -n +15 | xargs -r rm -rf
