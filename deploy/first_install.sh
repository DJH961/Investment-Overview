#!/usr/bin/env bash
# first_install.sh - start the v6 stack on the server and check it is healthy.
#
# Run it ON THE SERVER, inside /opt/investments (next to docker-compose.yml):
#
#   cd /opt/investments && ./first_install.sh
#
# Safe to run again at any time: every step checks before it changes anything.
# It never prints secret values, only the NAMES of keys that are missing.
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "ERROR: $*" >&2; exit 1; }
ok() { echo "ok   $*"; }

APP_ENV="app.env"
REQUIRED_KEYS=(
  INV_DASHBOARD_DB_PASSPHRASE
  INV_DASHBOARD_BACKUP_PASSPHRASE
  INV_DASHBOARD_WEBAUTHN_RP_ID
  INV_DASHBOARD_WEBAUTHN_ORIGIN
)

echo "==> Checking the server"

# 1. Docker
command -v docker >/dev/null 2>&1 || fail "Docker is not installed (run deploy/bootstrap.sh first)."
docker compose version >/dev/null 2>&1 || fail "'docker compose' is not available."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker (is your user in the 'docker' group?)."
ok "Docker and compose work"

# 2. GHCR login (the image is pulled from ghcr.io)
if grep -q '"ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null; then
  ok "Logged in to ghcr.io"
else
  fail "Not logged in to ghcr.io. Run: docker login ghcr.io -u DJH961   (paste the read:packages token at the prompt; see RUNBOOK 'Secrets' step C)"
fi

# 3. app.env: exists, mode 600, required keys present (values are never printed)
[ -f "$APP_ENV" ] || fail "$APP_ENV not found in $(pwd). Create it from backend/.env.example (RUNBOOK 'First install' step D)."
mode="$(stat -c '%a' "$APP_ENV")"
[ "$mode" = "600" ] || fail "$APP_ENV has mode $mode, expected 600. Run: chmod 600 $APP_ENV"
missing=()
for key in "${REQUIRED_KEYS[@]}"; do
  # A key counts when the line exists, is not commented out and has a non-empty value.
  if ! grep -Eq "^${key}=.+" "$APP_ENV"; then
    missing+=("$key")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  fail "$APP_ENV is missing a value for: ${missing[*]}"
fi
if grep -Eq '^INV_DASHBOARD_[A-Z_]*=(changeme|changeme-too)$' "$APP_ENV"; then
  fail "$APP_ENV still contains a 'changeme' placeholder. Replace it with a real secret (openssl rand -base64 32)."
fi
ok "$APP_ENV present, mode 600, required keys set"

# 4. rclone.conf (off-site backups)
[ -f rclone.conf ] || fail "rclone.conf not found. Copy rclone.conf.example, fill in the B2 key, chmod 600 (RUNBOOK 'Backups')."
rmode="$(stat -c '%a' rclone.conf)"
[ "$rmode" = "600" ] || fail "rclone.conf has mode $rmode, expected 600. Run: chmod 600 rclone.conf"
if grep -q '<application key' rclone.conf; then
  fail "rclone.conf still contains the example placeholders."
fi
# The backup container runs as the app user (uid 10001) and must be able to read it.
rowner="$(stat -c '%u' rclone.conf)"
[ "$rowner" = "10001" ] || fail "rclone.conf is owned by uid $rowner; the backup container (uid 10001) cannot read it. Run: sudo chown 10001:10001 rclone.conf"
ok "rclone.conf present, mode 600, readable by the backup container"

[ -f docker-compose.yml ] || fail "docker-compose.yml not found here."
[ -f Caddyfile ] || fail "Caddyfile not found here."

echo "==> Starting the stack"

# 5. Remove the Phase 0 placeholder web server; it would hold ports 80/443.
if docker ps -a --format '{{.Names}}' | grep -qx 'caddy-check'; then
  docker rm -f caddy-check >/dev/null
  ok "Removed the old caddy-check placeholder"
fi

touch .env
APP_ENV_FILE="$(pwd)/$APP_ENV"
export APP_ENV_FILE
docker compose pull
docker compose up -d
ok "docker compose up -d"

# 6. Wait for /api/health (from inside the app container: no ports are published).
echo "==> Waiting for the app to answer /api/health (up to 2 minutes)"
healthy=0
for _ in $(seq 1 30); do
  if docker compose exec -T app python -c \
    "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/health', timeout=3)" \
    >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 4
done
if [ "$healthy" -ne 1 ]; then
  docker compose logs --tail 40 app >&2 || true
  fail "The app did not become healthy. See the log above."
fi
ok "App is healthy"

cat <<'NEXT'

Next step: set your login password (you type it; it is not stored in any file):

  docker compose exec app inv-dashboard-set-password

Then upload your ledger (RUNBOOK 'First install', last step) and run, on your laptop:

  bash deploy/check.sh
NEXT
