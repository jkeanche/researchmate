#!/usr/bin/env bash
# Proves a backup can be restored, without touching the live database:
#   1. checks SHA256SUMS;
#   2. decrypts *.gpg archives (needs the private key on the machine running this);
#   3. restores database.dump into a temporary database and checks it
#      (migration history, core tables, row counts);
#   4. lists files.tar.gz and checks that every stored object it should hold is there;
#   5. drops the temporary database.
#
#   infrastructure/scripts/verify-backup.sh backups/researchmate-20261101T000000Z
#
# By default it runs Postgres commands inside the Compose "postgres" service.
# Set VERIFY_ADMIN_URL=postgres://user:pass@host:5432/postgres to use local
# client tools against another server instead (e.g. a separate restore host).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && { set -a; source .env; set +a; }

SRC="${1:?usage: verify-backup.sh <backup-dir>}"
WORK="$(mktemp -d)"
DB="rm_verify_$(date -u +%Y%m%d%H%M%S)_$$"
trap 'rm -rf "$WORK"' EXIT

pg() { # pg <tool> [args...]  — runs a Postgres client tool against the admin connection
  local tool="$1"; shift
  if [ -n "${VERIFY_ADMIN_URL:-}" ]; then
    "$tool" "$@"
  else
    docker compose exec -T postgres "$tool" -U "${POSTGRES_USER:-researchmate}" "$@"
  fi
}
url_for() { # database-specific connection argument for local tools
  if [ -n "${VERIFY_ADMIN_URL:-}" ]; then echo "--dbname=${VERIFY_ADMIN_URL%/*}/$1"; else echo "--dbname=$1"; fi
}

echo "1/5 Checksums"
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS)

echo "2/5 Decrypting (if encrypted)"
for f in database.dump files.tar.gz; do
  if [ -f "$SRC/$f.gpg" ]; then gpg --batch --quiet --output "$WORK/$f" --decrypt "$SRC/$f.gpg"; else cp "$SRC/$f" "$WORK/$f"; fi
done

echo "3/5 Restoring into temporary database $DB"
pg createdb $( [ -n "${VERIFY_ADMIN_URL:-}" ] && echo "--maintenance-db=$VERIFY_ADMIN_URL" ) "$DB"
cleanup_db() { pg dropdb $( [ -n "${VERIFY_ADMIN_URL:-}" ] && echo "--maintenance-db=$VERIFY_ADMIN_URL" ) --if-exists "$DB" >/dev/null 2>&1 || true; }
trap 'cleanup_db; rm -rf "$WORK"' EXIT
pg pg_restore --no-owner --exit-on-error "$(url_for "$DB")" < "$WORK/database.dump"
q() { pg psql "$(url_for "$DB")" -Atc "$1"; }
migrations=$(q "select count(*) from drizzle.__drizzle_migrations")
users=$(q "select count(*) from users")
orgs=$(q "select count(*) from organizations")
projects=$(q "select count(*) from research_projects")
versions=$(q "select count(*) from file_versions where purged_at is null and storage_driver = 'local'")
[ "$migrations" -gt 0 ] || { echo "FAIL: no migration history in the dump"; exit 1; }
[ "$(q "select count(*) from plans")" -gt 0 ] || { echo "FAIL: plan catalogue missing"; exit 1; }
echo "    migrations=$migrations users=$users organizations=$orgs projects=$projects local file versions=$versions"

echo "4/5 Checking the files archive"
tar -tzf "$WORK/files.tar.gz" > "$WORK/listing"
q "select 'files/' || storage_key from file_versions where purged_at is null and storage_driver = 'local'" | sort > "$WORK/expected"
sed 's|^\./||' "$WORK/listing" | sort > "$WORK/archived"
missing=$(comm -23 "$WORK/expected" "$WORK/archived" | wc -l)
echo "    archive entries=$(wc -l < "$WORK/listing") missing objects=$missing"
[ "$missing" -eq 0 ] || { echo "FAIL: $missing stored file(s) referenced by the database are missing from files.tar.gz"; comm -23 "$WORK/expected" "$WORK/archived" | head; exit 1; }

echo "5/5 Cleaning up"
cleanup_db
echo "OK: $SRC restores cleanly."
