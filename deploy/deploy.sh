#!/usr/bin/env bash
# deploy.sh - the ONLY thing the GitHub deploy key may run on the server.
#
# Install it once, owned by root and not writable by the deploy user:
#   sudo install -o root -g root -m 755 deploy.sh /opt/investments/deploy.sh
# and restrict the deploy key in ~/.ssh/authorized_keys of the deploy user:
#   restrict,command="/opt/investments/deploy.sh" ssh-ed25519 AAAA... inv-deploy
# (see deploy/RUNBOOK.md, "Secrets", B). Because the key can only run this script,
# a leaked key can deploy an image tag from our registry; it cannot open a shell.
#
# Protocol (the workflow calls it like this):
#   tar -C deploy -czf - docker-compose.yml Caddyfile restore.sh first_install.sh \
#     | ssh server "deploy <40-hex git sha>"
# The command line arrives in SSH_ORIGINAL_COMMAND; the tar stream arrives on stdin.
# Only the four whitelisted file names are installed; this script is never replaced
# by a deploy (update it by hand when it changes).
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/investments}"
IMAGE_REPO="${DEPLOY_IMAGE_REPO:-ghcr.io/djh961/investment-overview}"
ALLOWED_FILES=(docker-compose.yml Caddyfile restore.sh first_install.sh)

die() { echo "deploy.sh: $*" >&2; exit 2; }

read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-${*:-}}"
[ "${#words[@]}" -eq 2 ] && [ "${words[0]}" = "deploy" ] || die "usage: deploy <40-hex git sha>"
NEW_TAG="${words[1]}"
[[ "$NEW_TAG" =~ ^[0-9a-f]{40}$ ]] || die "the tag must be a full 40-character git sha"

cd "$DIR"
work="$(mktemp -d "$DIR/.deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Unpack the files pushed from the commit being deployed, into a scratch directory.
tar -xzf - -C "$work" --no-same-owner --no-same-permissions
for f in "${ALLOWED_FILES[@]}"; do
  [ -f "$work/$f" ] && [ ! -L "$work/$f" ] || die "missing or unsafe file in the upload: $f"
done
for f in "${ALLOWED_FILES[@]}"; do
  install -m 644 "$work/$f" "$DIR/.$f.new"
  mv "$DIR/.$f.new" "$DIR/$f"
done
chmod 755 restore.sh first_install.sh

touch .env
PREV_TAG="$(sed -n 's/^APP_TAG=//p' .env | tail -n 1)"
PREV_TAG="${PREV_TAG:-latest}"

set_tag() {
  grep -v '^APP_TAG=' .env >.env.tmp || true
  echo "APP_TAG=$1" >>.env.tmp
  mv .env.tmp .env
}

healthy() {
  for _ in $(seq 1 30); do
    if docker compose exec -T app python -c \
      "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/health', timeout=3)" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 4
  done
  return 1
}

# Keep only the running image and the previous one (the rollback target). Every
# deploy pulls a new sha-tagged image, and `docker image prune` only removes
# untagged ones, so without this the old tags slowly fill the disk.
prune_old_images() {
  local tag
  docker image ls "$IMAGE_REPO" --format '{{.Tag}}' | sort -u | while read -r tag; do
    case "$tag" in
      "$NEW_TAG" | "$PREV_TAG") ;;
      *) docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || true ;;
    esac
  done
  docker image prune -f >/dev/null
}

set_tag "$NEW_TAG"
docker compose pull app
docker compose up -d app
if healthy; then
  echo "Deployed $NEW_TAG (previous: $PREV_TAG)"
  # Pick up a changed Caddyfile (no-op when caddy is not running yet).
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  prune_old_images
  exit 0
fi

echo "Health check failed; rolling back to $PREV_TAG" >&2
docker compose logs --tail 50 app >&2 || true
set_tag "$PREV_TAG"
docker compose up -d app
healthy || echo "Rollback target is also unhealthy" >&2
exit 1
