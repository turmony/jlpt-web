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
JLPT_PROJECTS_ROOT="${JLPT_PROJECTS_ROOT:-$HOME/projects}"
if ! command -v caddy >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi
node -e "const major=Number(process.versions.node.split('.')[0]);if(major<22 || major>=25)throw Error('Node 22–24 is required')"
# npm ci can clear the target of a node_modules directory symlink. Detach
# this release before reinstalling so retained releases keep their packages.
if [ -L node_modules ]; then
  unlink node_modules
fi
npm ci --no-audit --no-fund
npm run build:chat
node scripts/build-server.mjs /srv/jlpt/static
python3 scripts/setup_study.py --projects "$JLPT_PROJECTS_ROOT"
python3 scripts/configure_server.py --projects "$JLPT_PROJECTS_ROOT" --origin "$1"
cd "$JLPT_PROJECTS_ROOT/jlpt-study/.worktrees/web-study"
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
