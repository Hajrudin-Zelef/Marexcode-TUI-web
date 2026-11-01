#!/bin/sh
# Vérifie l'état de Marexcode Web (services, ports, URLs, fichiers).
# Peut tourner sur PVE (via pct) ou localement. --dry-run non applicable.
set -u
ok=0; ko=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "  OK   $1"; ok=$((ok+1)); else echo "  FAIL $1"; ko=$((ko+1)); fi; }

echo "== Fichiers du dépôt =="
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
chk "app/index.html"            "test -s '$ROOT/app/index.html'"
chk "gate (server.js)"          "test -s '$ROOT/host/lxc102/opt/marexgate/server.js'"
chk "marexssh (server.js)"      "test -s '$ROOT/host/neva/opt/marexssh/server.js'"
chk "vhost 105"                 "test -s '$ROOT/host/lxc105/nginx/sites-available/marexcode.conf'"
chk "docs (26)"                 "test \$(ls '$ROOT/docs'/*.md | wc -l) -ge 26"

if [ "$(id -u)" = 0 ] && command -v pct >/dev/null 2>&1; then
  echo "== LXC 102 =="
  for s in nginx marexgate marexws filebrowser-marexcode netdata; do
    chk "102 $s" "pct exec 102 -- systemctl is-active '$s'"
  done
  chk "102 marexws 7691"  "pct exec 102 -- ss -tln | grep -q 127.0.0.1:7691"
  chk "102 gate 8789"     "pct exec 102 -- ss -tln | grep -q 127.0.0.1:8789"
  chk "102 nginx -t"      "pct exec 102 -- nginx -t"

  echo "== LXC 105 =="
  for s in nginx fail2ban; do
    chk "105 $s" "pct exec 105 -- systemctl is-active '$s'"
  done
  chk "105 nginx -t"      "pct exec 105 -- nginx -t"
  chk "105 page"          "pct exec 105 -- test -s /var/www/marexcode-web/index.html"

  echo "== PVE =="
  chk "marexssh"          "systemctl is-active marexssh"
  chk "tailscaled"        "systemctl is-active tailscaled"
  chk "nginx"             "systemctl is-active nginx"
  chk "serve /ssh"        "tailscale serve status | grep -q /ssh"
fi

echo
echo "Résultat : $ok OK, $ko FAIL"
[ "$ko" -eq 0 ]
