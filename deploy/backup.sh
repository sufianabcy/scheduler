#!/usr/bin/env bash
# Nightly database backup, run by the planner-backup timer (03:30 IST) as the "planner" user.
# Makes a consistent copy with SQLite's backup command, checks it, keeps 7 days on the server
# and, when BACKUP_BUCKET is set, uploads it to s3://$BACKUP_BUCKET/planner/.
# Run it by hand with: sudo systemctl start planner-backup

set -euo pipefail

DB="${DB_PATH:-/var/lib/planner/planner.db}"
DIR="${BACKUP_DIR:-$(dirname "$DB")/backups}"
stamp="$(TZ=Asia/Kolkata date +%F)"
file="$DIR/planner-$stamp.db"

mkdir -p "$DIR"
sqlite3 "$DB" ".backup '$file'"
# The copy inherits WAL mode; switch it to a single self-contained file before checking and zipping it.
sqlite3 "$file" 'PRAGMA journal_mode=DELETE' >/dev/null
check="$(sqlite3 "$file" 'PRAGMA integrity_check')"
[[ "$check" == "ok" ]] || { echo "Backup failed its integrity check: $check" >&2; rm -f "$file"; exit 1; }
rm -f "$file-wal" "$file-shm"
gzip -f "$file"
find "$DIR" -name 'planner-*.db.gz' -mtime +7 -delete
echo "Saved $file.gz"

if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  aws s3 cp "$file.gz" "s3://$BACKUP_BUCKET/planner/planner-$stamp.db.gz" --only-show-errors
  echo "Uploaded to s3://$BACKUP_BUCKET/planner/"
fi
