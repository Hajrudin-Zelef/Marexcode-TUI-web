#!/bin/sh
# Déploie les composants Marexcode Web de l'hôte PVE.
# À exécuter sur PVE, depuis la racine du dépôt. --dry-run pour simuler.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "[dry] $*"; else "$@"; fi; }

install -d -m 755 /opt/marexssh
run install -m 644 "$ROOT/host/neva/opt/marexssh/server.js" /opt/marexssh/server.js
run install -m 644 "$ROOT/host/neva/opt/marexssh/package.json" /opt/marexssh/package.json
run install -m 644 "$ROOT/host/neva/opt/marexssh/package-lock.json" /opt/marexssh/package-lock.json

if [ ! -d /opt/marexssh/node_modules ]; then
  if [ -d "$ROOT/deps/neva/node24/node_modules" ]; then
    run cp -a "$ROOT/deps/neva/node24/node_modules" /opt/marexssh/
  else
    echo "node_modules absent : lancer 'npm ci' dans /opt/marexssh" >&2
  fi
fi

install -d -m 750 -o root -g marexssh /etc/marexssh 2>/dev/null || true
run install -m 640 -o root -g marexssh "$ROOT/host/neva/etc/marexssh/config.json" /etc/marexssh/config.json
if [ -f "$ROOT/ForkOffline/neva/proxy.key" ]; then
  run install -m 640 -o root -g marexssh "$ROOT/ForkOffline/neva/proxy.key" /etc/marexssh/proxy.key
fi

run install -m 644 "$ROOT/host/neva/etc/systemd/system/marexssh.service" /etc/systemd/system/
run install -m 644 "$ROOT/host/neva/etc/systemd/system/marex-tailnet-guard.service" /etc/systemd/system/
run install -m 644 "$ROOT/host/neva/etc/systemd/system/marex-tailnet-guard.timer" /etc/systemd/system/
run install -m 750 "$ROOT/host/neva/usr/local/sbin/marexssh" /usr/local/sbin/marexssh
run install -m 750 "$ROOT/host/neva/usr/local/sbin/marex-tailnet-guard" /usr/local/sbin/marex-tailnet-guard

run install -m 644 "$ROOT/host/neva/nginx/stream-router.conf" /etc/nginx/stream-conf.d/stream-router.conf
run install -m 644 "$ROOT/host/neva/nginx/router-map.http" /etc/nginx/router-map.http
run install -m 644 "$ROOT/host/neva/nginx/router-map.stream" /etc/nginx/router-map.stream
run install -m 644 "$ROOT/host/neva/nginx/router" /etc/nginx/sites-available/router

run systemctl daemon-reload
run nginx -t
run systemctl reload nginx
run systemctl restart marexssh
echo "PVE : déployé."
