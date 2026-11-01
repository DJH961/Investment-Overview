#!/usr/bin/env bash
# restore.sh - bring the database back from a sealed snapshot, in ONE command.
#
#   ./restore.sh                 restore the newest snapshot
#   ./restore.sh --at <name>     restore a specific snapshot, for example
#                                snapshot-20261101-120000.sealed.json
#   ./restore.sh --list          only show the snapshots, change nothing
#   ./restore.sh --yes           do not ask for confirmation
#
# Run it on the server, inside the folder that holds docker-compose.yml
# (normally ~/investments). What it does, in plain words:
#   1. Pulls the snapshot files from Backblaze B2 into the app's backup folder
#      (uses the "backup" rclone service; files already present are skipped).
#   2. Stops the app so nothing writes to the database during the swap.
#   3. Runs inv-dashboard-restore, which checks the snapshot and swaps it in.
#      The database it replaces is kept as app.sqlite.before-restore-<time>.
#   4. Starts the app again (also if the restore failed, with the OLD database).
set -euo pipefail

cd "$(dirname "$0")"

SNAPSHOT=""
LIST_ONLY=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --at) SNAPSHOT="${2:?--at needs a snapshot file name}"; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

REMOTE="${BACKUP_REMOTE:-b2:Investment-Overview/snapshots}"

echo "==> Fetching snapshots from $REMOTE"
# --ignore-existing: never overwrite a local file; --immutable is not needed for download.
docker compose run --rm --no-deps --entrypoint rclone backup \
  copy "$REMOTE" /data/backups --ignore-existing --cache-dir /tmp/rclone

if [ "$LIST_ONLY" -eq 1 ]; then
  docker compose run --rm --no-deps app inv-dashboard-restore --list
  exit 0
fi

if [ -n "$SNAPSHOT" ]; then
  SELECT=(--snapshot "$SNAPSHOT")
else
  SELECT=(--latest)
fi
CONFIRM=()
[ "$ASSUME_YES" -eq 1 ] && CONFIRM=(--yes)

echo "==> Stopping the app"
docker compose stop app

# Whatever happens next, start the app again so the site comes back.
trap 'echo "==> Starting the app"; docker compose up -d app' EXIT

echo "==> Restoring (${SELECT[*]})"
docker compose run --rm --no-deps app inv-dashboard-restore "${SELECT[@]}" "${CONFIRM[@]}"

echo "==> Done. Open the site and compare the totals with a recent screenshot."
