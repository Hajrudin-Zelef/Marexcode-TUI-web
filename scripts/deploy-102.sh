#!/bin/sh
# Déploie les composants Marexcode Web dans le LXC 102.
# À exécuter DANS le 102, depuis la racine du dépôt. --dry-run pour simuler.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "[dry] $*"; else "$@"; fi; }

install -d -m 755 /opt/marexgate
run install -m 644 "$ROOT"/host/lxc102/opt/marexgate/*.js /opt/marexgate/
run install -m 644 "$ROOT"/host/lxc102/opt/marexgate/package*.json /opt/marexgate/
if [ ! -d /opt/marexgate/node_modules ] && [ -d "$ROOT/deps/lxc102/marexgate/node_modules" ]; then
  run cp -a "$ROOT/deps/lxc102/marexgate/node_modules" /opt/marexgate/
fi

install -d -m 750 -o root -g marexgate /etc/marexcode 2>/dev/null || true
run install -m 640 -o root -g marexgate "$ROOT/host/lxc102/etc/marexcode/security.json" /etc/marexcode/security.json
[ -f "$ROOT/ForkOffline/lxc102/proxy.key" ] && run install -m 640 -o root -g marexgate "$ROOT/ForkOffline/lxc102/proxy.key" /etc/marexcode/proxy.key
[ -f "$ROOT/ForkOffline/lxc102/alerts.env" ] && run install -m 640 -o root -g marexgate "$ROOT/ForkOffline/lxc102/alerts.env" /etc/marexcode/alerts.env

run install -d -m 755 /opt/marexfile-branding
run cp -a "$ROOT/host/lxc102/opt/marexfile-branding/." /opt/marexfile-branding/
run chown -R root:root /opt/marexfile-branding
run find /opt/marexfile-branding -type d -exec chmod 755 {} +
run find /opt/marexfile-branding -type f -exec chmod 644 {} +

run install -m 644 "$ROOT"/host/lxc102/etc/systemd/system/*.service /etc/systemd/system/
run install -m 644 "$ROOT"/host/lxc102/etc/nginx/conf.d/*.conf /etc/nginx/conf.d/
run install -m 644 "$ROOT"/host/lxc102/etc/nginx/snippets/*.conf /etc/nginx/snippets/
run install -m 644 "$ROOT/host/lxc102/etc/logrotate.d/marexgate" /etc/logrotate.d/marexgate
run install -m 755 "$ROOT"/host/lxc102/usr/local/bin/* /usr/local/bin/

run systemctl daemon-reload
run nginx -t
run systemctl reload nginx
run systemctl restart marexgate marexws
run systemctl restart 'ttyd-marexcode@1' 'ttyd-marexcode@2' 'ttyd-marexcode@3' 'ttyd-marexcode@4'
run systemctl restart filebrowser-marexcode
echo "102 : déployé."
