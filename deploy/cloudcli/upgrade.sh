#!/usr/bin/env bash
# Upgrades CloudCLI without touching the running install until the patch has passed.
#   upgrade.sh <version>          stage /srv/cloudcli-next (install, drop the Codex binary, patch)
#   upgrade.sh <version> --swap   swap it in, restart, health-check, roll back on failure
# The old install stays in /srv/cloudcli.prev; delete it by hand once /code/ is confirmed working.
set -euo pipefail

version=${1:?usage: upgrade.sh <version> [--swap]}
base=/srv/cloudcli
next=$base-next
prev=$base.prev
cache=/tmp/npm-cache-up
here=$(dirname "$(readlink -f "$0")")
cli=node_modules/@cloudcli-ai/cloudcli

if [[ ${2:-} == --swap ]]; then
  [[ -d $next ]] || { echo "$next missing: stage first" >&2; exit 1; }
  [[ ! -e $prev ]] || { echo "$prev exists: remove the previous backup first" >&2; exit 1; }
  systemctl stop cloudcli
  mv "$base" "$prev"
  mv "$next" "$base"
  systemctl start cloudcli
  for _ in $(seq 20); do
    sleep 2
    if curl -fsS -o /dev/null http://127.0.0.1:3001/health; then
      echo "CloudCLI $version is up. Check /code/ in a browser, then: rm -r $prev"
      exit 0
    fi
  done
  echo "health check failed, rolling back" >&2
  systemctl stop cloudcli
  mv "$base" "$next"
  mv "$prev" "$base"
  latest=$(ls -d /var/backups/cloudcli-db-* | tail -1)
  rm -r /root/.cloudcli && cp -a "$latest" /root/.cloudcli
  systemctl start cloudcli
  exit 1
fi

[[ ! -e $next && ! -e $cache ]] || { echo "$next or $cache left over: remove it first" >&2; exit 1; }
# Install needs about 1.3 GB plus an npm cache of about 0.9 GB; the old install is kept alongside.
free_kb=$(df --output=avail -k /srv | tail -1)
(( free_kb > 2500000 )) || { echo "under 2.5 GB free on /srv" >&2; exit 1; }

# The upgrade may migrate the database; keep a copy for the rollback.
cp -a /root/.cloudcli "/var/backups/cloudcli-db-$(date -u +%Y%m%dT%H%M%SZ)"

mkdir "$next"
cp "$base/package.json" "$here/patch-subpath.mjs" "$here/subpath-shim.js" "$here/quota.py" "$next/"
cd "$next"
trap 'rm -rf "$cache"' EXIT
NODE_OPTIONS=--max-old-space-size=512 npm install --save-exact "@cloudcli-ai/cloudcli@$version" \
  --cache "$cache" --no-audit --no-fund --loglevel=error
# Codex is unused: keep the JS packages (imported at startup) but drop the 370 MB native binary.
rm -rf node_modules/@openai/codex-linux-x64
node patch-subpath.mjs "$next/$cli"
node patch-subpath.mjs "$next/$cli"   # a second run must also pass
echo "Staged CloudCLI $version in $next. Apply with: $0 $version --swap"
