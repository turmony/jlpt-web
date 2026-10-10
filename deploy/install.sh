#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: bash deploy/install.sh https://public-proxy-endpoint' >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run as the server administrator' >&2
  exit 2
fi
cd /srv/jlpt/app
export PATH="/root/.local/bin:$PATH"
if ! command -v caddy >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi
node scripts/build-server.mjs /srv/jlpt/static
python3 scripts/setup_study.py
python3 scripts/configure_server.py --origin "$1"
cd /srv/jlpt/worktrees/study
uv sync --no-dev
git config user.name 'JLPT Web'
git config user.email 'jlpt-web@localhost'
cd /srv/jlpt/app
install -m 644 deploy/jlpt.service /etc/systemd/system/jlpt.service
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now jlpt.service
systemctl restart jlpt.service
systemctl enable --now caddy.service
systemctl reload caddy.service
echo 'Site is running; website password is stored in /srv/jlpt/state/website-password'
