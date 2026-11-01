#!/bin/sh
# Contrôle de restauration : vérifie l'intégrité des éléments de ForkOffline.
# À exécuter n'importe où (lecture seule).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
F="$ROOT/ForkOffline"
fail=0

echo "== Bases SQLite =="
for db in "$F/lxc102/gate.db" "$F/lxc102/filebrowser.db"; do
  if [ -f "$db" ]; then
    if node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});d.prepare("select 1").get();d.close();' "$db" 2>/dev/null; then
      echo "  OK   $db"
    else
      echo "  FAIL $db (illisible)"; fail=1
    fi
  else
    echo "  --   $db absent"
  fi
done

echo "== Clés et secrets =="
for f in "$F/neva/proxy.key" "$F/lxc102/proxy.key" "$F/lxc102/alerts.env" "$F/lxc105/htpasswd"; do
  if [ -f "$f" ]; then echo "  OK   $f"; else echo "  FAIL $f absent"; fail=1; fi
done

echo "== Certificats =="
if [ -d "$F/lxc105/letsencrypt/live" ]; then
  for d in "$F"/lxc105/letsencrypt/live/*/; do
    [ -f "$d/cert.pem" ] || continue
    exp=$(openssl x509 -enddate -noout -in "$d/cert.pem" 2>/dev/null | cut -d= -f2)
    echo "  $d : $exp"
  done
else
  echo "  -- letsencrypt absent"
fi

echo "== Permissions =="
perm=$(stat -c %a "$F" 2>/dev/null || echo "?")
echo "  ForkOffline : $perm (attendu 700)"

exit $fail
