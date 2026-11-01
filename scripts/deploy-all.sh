#!/bin/sh
# Orchestre le déploiement complet depuis PVE (hôte Proxmox).
# Nécessite root (pct). --dry-run pour simuler.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "[dry] $*"; else "$@"; fi; }

echo "== PVE =="
run "$ROOT/scripts/deploy-neva.sh"

echo "== LXC 102 =="
run tar czf /tmp/marexcode-web-102.tgz -C "$ROOT" host/lxc102 scripts ForkOffline/lxc102
run pct push 102 /tmp/marexcode-web-102.tgz /tmp/marexcode-web-102.tgz
run pct exec 102 -- sh -c 'rm -rf /tmp/repo && mkdir -p /tmp/repo && tar xzf /tmp/marexcode-web-102.tgz -C /tmp/repo && sh /tmp/repo/scripts/deploy-102.sh'
run rm -f /tmp/marexcode-web-102.tgz

echo "== LXC 105 =="
run tar czf /tmp/marexcode-web-105.tgz -C "$ROOT" host/lxc105 scripts ForkOffline/lxc105
run pct push 105 /tmp/marexcode-web-105.tgz /tmp/marexcode-web-105.tgz
run pct exec 105 -- sh -c 'rm -rf /tmp/repo && mkdir -p /tmp/repo && tar xzf /tmp/marexcode-web-105.tgz -C /tmp/repo && sh /tmp/repo/scripts/deploy-105.sh'
run rm -f /tmp/marexcode-web-105.tgz

echo "Déploiement complet terminé."
