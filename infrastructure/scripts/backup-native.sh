#!/usr/bin/env bash
# Backs up a native (non-Docker) installation: the database and research files.
# Installed by install-ubuntu.sh as researchmate-backup.service (daily timer).
#
#   backup-native.sh [--env-file /etc/researchmate/researchmate.env] [--dest /var/backups/researchmate]
#
# Produces <dest>/researchmate-<timestamp>/{database.dump,files.tar.gz,SHA256SUMS},
# the same layout as backup.sh, so verify-backup.sh and restore steps apply.
# Optional settings in the env file (see backup.sh): BACKUP_GPG_RECIPIENT,
# BACKUP_RCLONE_REMOTE, BACKUP_KEEP (default 14).
set -euo pipefail

ENV_FILE=/etc/researchmate/researchmate.env
DEST=/var/backups/researchmate
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a
: "${DATABASE_URL:?DATABASE_URL missing from $ENV_FILE}"
STORAGE="${LOCAL_STORAGE_ROOT:-/var/lib/researchmate}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/researchmate-$STAMP"
umask 077
mkdir -p "$OUT"

echo "Dumping database..."
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --file="$OUT/database.dump"
pg_restore --list "$OUT/database.dump" > /dev/null   # a truncated dump fails here

if [ "${STORAGE_DRIVER:-local}" = "s3" ]; then
  echo "NOTE: STORAGE_DRIVER=s3: research files live in the bucket; protect them with bucket versioning and replication."
fi
echo "Archiving research files from $STORAGE..."
dirs=()
for d in files generated; do [ -d "$STORAGE/$d" ] && dirs+=("$d"); done
tar -C "$STORAGE" -czf "$OUT/files.tar.gz" "${dirs[@]}"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "Encrypting for $BACKUP_GPG_RECIPIENT..."
  for f in database.dump files.tar.gz; do
    gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$OUT/$f.gpg" --encrypt "$OUT/$f"
    shred -u "$OUT/$f" 2>/dev/null || rm -f "$OUT/$f"
  done
fi

(cd "$OUT" && sha256sum database.dump* files.tar.gz* > SHA256SUMS)
echo "Backup written to $OUT ($(du -sh "$OUT" | cut -f1))"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "Copying off-site to $BACKUP_RCLONE_REMOTE..."
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/researchmate-$STAMP"
fi

ls -1dt "$DEST"/researchmate-* 2>/dev/null | tail -n +"$(( ${BACKUP_KEEP:-14} + 1 ))" | xargs -r rm -rf
