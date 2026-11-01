#!/bin/sh
# Installe les prérequis Marexcode Web dans le LXC 102.
# Node 24, ttyd, FileBrowser, Netdata, tmux, utilisateur marexgate.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux curl ca-certificates openssl logrotate >/dev/null

id marexgate >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin marexgate
install -d -m 750 -o root -g marexgate /etc/marexcode
install -d -m 750 -o marexgate -g marexgate /var/lib/marexgate
install -d -m 755 /opt/marexgate

# Node 24 (dépôt système ou binaire fourni)
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  if [ -x "$ROOT/deps/lxc102/bin/node" ]; then
    install -m 755 "$ROOT/deps/lxc102/bin/node" /usr/bin/node
  else
    echo "Node 24 manquant : installer Node >= 22 puis relancer" >&2
  fi
fi

for b in ttyd filebrowser; do
  if [ -x "$ROOT/deps/lxc102/bin/$b" ]; then
    install -m 755 "$ROOT/deps/lxc102/bin/$b" "/usr/local/bin/$b"
  fi
done

if [ -x "$ROOT/deps/lxc102/bin/bun" ] && [ ! -x /home/sam/.bun/bin/bun ]; then
  install -d -m 755 /home/sam/.bun/bin
  install -m 755 "$ROOT/deps/lxc102/bin/bun" /home/sam/.bun/bin/bun
  chown -R sam:sam /home/sam/.bun
fi

if [ ! -x /usr/sbin/netdata ] && [ -x "$ROOT/deps/lxc102/netdata/netdata" ]; then
  install -m 755 "$ROOT/deps/lxc102/netdata/netdata" /usr/sbin/netdata
  install -d -m 755 /usr/lib/netdata
  cp -a "$ROOT/deps/lxc102/netdata/lib/." /usr/lib/netdata/ 2>/dev/null || true
fi

if [ ! -d /opt/marexgate/node_modules ] && [ -d "$ROOT/deps/lxc102/marexgate/node_modules" ]; then
  cp -a "$ROOT/deps/lxc102/marexgate/node_modules" /opt/marexgate/
fi

echo "102 : prérequis installés. Lancer scripts/deploy-102.sh"
