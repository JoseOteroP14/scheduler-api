#!/usr/bin/env bash
# Runs on the VPS inside /opt/scheduler. Activates .env.next, keeping the previous .env for rollback.
# Usage: echo "$GHCR_TOKEN" | bash remote-deploy.sh <registry user>
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY_USER=${1:?usage: remote-deploy.sh <registry user>}
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
docker login ghcr.io -u "$REGISTRY_USER" --password-stdin

[ -f .env ] && cp .env .env.previous
mv .env.next .env

if docker compose pull --quiet && docker compose up -d --wait --wait-timeout 180 --remove-orphans; then
  docker image prune -af --filter "until=168h" >/dev/null
  docker compose ps
  exit 0
fi

echo "::error::Deployment failed; recent logs follow." >&2
docker compose logs --tail 100 >&2 || true
if [ -f .env.previous ]; then
  echo "Rolling back to $(grep '^API_IMAGE=' .env.previous)" >&2
  mv .env.previous .env
  docker compose up -d --wait --wait-timeout 180 --remove-orphans || true
fi
exit 1
