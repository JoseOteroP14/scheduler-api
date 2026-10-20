#!/usr/bin/env bash
# One-time, idempotent VPS setup for GitHub Actions deployments.
# Usage: sudo bash bootstrap-vps.sh "<deploy SSH public key>"
set -euo pipefail

DEPLOY_USER=deploy
APP_DIR=/opt/scheduler
PUBLIC_KEY=${1:?usage: bootstrap-vps.sh "<deploy SSH public key>"}

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  . /etc/os-release
  apt-get update
  apt-get install -y ca-certificates curl
  if curl -fsSIo /dev/null "https://download.docker.com/linux/ubuntu/dists/${VERSION_CODENAME}/Release"; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    # Docker's repo doesn't publish this Ubuntu release yet; use Ubuntu's own packages.
    apt-get install -y docker.io docker-compose-v2 docker-buildx
  fi
  systemctl enable --now docker
fi

id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
AUTH_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTH_KEYS"
grep -qxF "$PUBLIC_KEY" "$AUTH_KEYS" || echo "$PUBLIC_KEY" >>"$AUTH_KEYS"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/secrets"
# The database password is generated here and never leaves the server.
# Compose bind-mounts the file with host permissions and the API runs as a non-root uid, so the file must be
# world-readable; the 700 secrets directory keeps other host users out.
if [ ! -s "$APP_DIR/secrets/postgres_password.txt" ]; then
  openssl rand -hex 24 >"$APP_DIR/secrets/postgres_password.txt"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/secrets/postgres_password.txt"
chmod 644 "$APP_DIR/secrets/postgres_password.txt"

docker --version
docker compose version
echo "VPS ready: deploy user '$DEPLOY_USER', app dir '$APP_DIR'."
