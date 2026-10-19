#!/usr/bin/env bash
# Switches the server to a new version. GitHub Actions runs it as the "deploy" user after unpacking the
# version into /opt/planner/releases/<id>:
#   bash /opt/planner/releases/<id>/deploy/release.sh <id>
#
# It points /opt/planner/current at the new version, restarts the app and checks /api/health.
# If the app doesn't come up healthy within 20 seconds, it switches back to the previous version.
# Keeps the 5 newest versions.

set -euo pipefail

ROOT="${PLANNER_ROOT:-/opt/planner}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
RESTART="${RESTART:-sudo systemctl restart planner}"
KEEP=5

id="${1:?Pass the release id}"
new="$ROOT/releases/$id"
[[ -d "$new/server/src" ]] || { echo "No release at $new" >&2; exit 1; }

previous="$(readlink "$ROOT/current" || true)"

healthy() {
  for _ in $(seq 20); do
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

switch_to() {
  ln -sfn "$1" "$ROOT/current"
  $RESTART
}

echo "Switching to $id"
switch_to "$new"

if ! healthy; then
  echo "The new version did not start; see: journalctl -u planner -n 50" >&2
  if [[ -n "$previous" && -d "$previous" ]]; then
    echo "Switching back to $(basename "$previous")" >&2
    switch_to "$previous"
    healthy || echo "The previous version is not healthy either." >&2
    rm -rf "$new"
  fi
  rm -f "$ROOT/incoming/$id.tar.gz"
  exit 1
fi
echo "Healthy: $HEALTH_URL"

# Tidy up: the uploaded archive and versions beyond the newest $KEEP (never the current one).
rm -f "$ROOT/incoming/$id.tar.gz"
current="$(readlink "$ROOT/current")"
ls -1dt "$ROOT"/releases/*/ | sed 's:/$::' | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$old" == "$current" ]] || rm -rf "$old"
done
echo "Done"
