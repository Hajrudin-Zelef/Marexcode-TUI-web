#!/bin/sh
# Sauvegarde immédiate des données et secrets de Marexcode Web.
# À exécuter sur la machine concernée (102 ou PVE). Écrit hors du dépôt.
set -eu
DEST=${DEST:-/var/backups/marexcode-web}
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$DEST/$STAMP"
mkdir -p "$OUT"

if [ -d /opt/marexgate ]; then
  systemctl stop marexgate filebrowser-marexcode 2>/dev/null || true
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/marexgate/gate.db");d.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();d.close();' 2>/dev/null || true
  cp -a /var/lib/marexgate/gate.db "$OUT/gate.db" 2>/dev/null || true
  cp -a /home/sam/.filebrowser.db "$OUT/filebrowser.db" 2>/dev/null || true
  cp -a /etc/marexcode "$OUT/etc-marexcode" 2>/dev/null || true
  cp -a /opt/marexgate/*.js /opt/marexgate/package*.json "$OUT/" 2>/dev/null || true
  cp -a /opt/marexfile-branding "$OUT/branding" 2>/dev/null || true
  systemctl start marexgate filebrowser-marexcode 2>/dev/null || true
  echo "102 : $OUT"
fi

if [ -d /opt/marexssh ]; then
  mkdir -p "$OUT/neva"
  cp -a /etc/marexssh "$OUT/neva/etc-marexssh" 2>/dev/null || true
  cp -a /opt/marexssh/*.js /opt/marexssh/package*.json "$OUT/neva/" 2>/dev/null || true
  cp -a /var/lib/marexssh "$OUT/neva/var-lib-marexssh" 2>/dev/null || true
  echo "PVE : $OUT"
fi

chmod -R go-rwx "$OUT"
echo "Sauvegarde terminée : $OUT"
