#!/bin/sh
# Installe les prérequis Marexcode Web sur l'hôte PVE.
# Node 24 dédié dans /opt/marexssh, utilisateur système marexssh.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_DIR=/opt/marexssh
NODE_VER=${NODE_VER:-v24.22.2}

id marexssh >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin marexssh
install -d -m 750 -o root -g marexssh /etc/marexssh
install -d -m 750 -o marexssh -g marexssh /var/lib/marexssh

if [ ! -x "$NODE_DIR/bin/node" ]; then
  install -d -m 755 "$NODE_DIR"
  if [ -d "$ROOT/deps/neva/node24/bin" ]; then
    cp -a "$ROOT/deps/neva/node24/." "$NODE_DIR/"
  else
    tmp=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
    tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
    rm -rf "$tmp"
  fi
fi
"$NODE_DIR/bin/node" -v

if [ ! -d "$NODE_DIR/node_modules" ]; then
  cp -a "$ROOT/host/neva/opt/marexssh/package.json" "$NODE_DIR/"
  cp -a "$ROOT/host/neva/opt/marexssh/package-lock.json" "$NODE_DIR/"
  ( cd "$NODE_DIR" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --no-audit --no-fund )
fi

echo "PVE : prérequis installés. Lancer scripts/deploy-neva.sh"
