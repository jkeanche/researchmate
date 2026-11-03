#!/usr/bin/env bash
# Backs up the database and research files from the Docker Compose stack.
#
#   infrastructure/scripts/backup.sh [backup-dir]     (default ./backups)
#
# Produces <dir>/researchmate-<timestamp>/{database.dump,files.tar.gz,SHA256SUMS}.
#
# Optional (set in .env):
#   BACKUP_GPG_RECIPIENT   encrypt both archives to this GPG public key (the
#                          private key should NOT live on this server)
#   BACKUP_RCLONE_REMOTE   copy the backup off the server, e.g. "b2:rm-backups"
#   BACKUP_KEEP            local backups to keep (default 14)
#
# Verify regularly with infrastructure/scripts/verify-backup.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/researchmate-$STAMP"
mkdir -p "$OUT"
chmod 700 "$OUT"

echo "Dumping database..."
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-researchmate}" -d "${POSTGRES_DB:-researchmate}" --format=custom --no-owner > "$OUT/database.dump"
# A truncated dump still exits 0 when the pipe breaks late; check it lists cleanly.
docker compose exec -T postgres pg_restore --list < "$OUT/database.dump" > /dev/null

if [ "${STORAGE_DRIVER:-local}" = "s3" ]; then
  echo "NOTE: STORAGE_DRIVER=s3 — research files live in the bucket. Protect them with bucket versioning"
  echo "      and replication; only locally generated files are archived here."
fi
echo "Archiving research files..."
docker compose run --rm --no-deps -v "$(cd "$OUT" && pwd)":/backup --entrypoint sh researchmate-worker \
  -c "tar -C /var/lib/researchmate -czf /backup/files.tar.gz files generated"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "Encrypting for ${BACKUP_GPG_RECIPIENT}..."
  for f in database.dump files.tar.gz; do
    gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$OUT/$f.gpg" --encrypt "$OUT/$f"
    shred -u "$OUT/$f" 2>/dev/null || rm -f "$OUT/$f"
  done
fi

(cd "$OUT" && sha256sum database.dump* files.tar.gz* > SHA256SUMS)
echo "Backup written to $OUT"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "Copying off-site to $BACKUP_RCLONE_REMOTE..."
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/researchmate-$STAMP"
fi

ls -1dt "$DEST"/researchmate-* 2>/dev/null | tail -n +"$(( ${BACKUP_KEEP:-14} + 1 ))" | xargs -r rm -rf
