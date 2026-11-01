#!/bin/sh
# Déploie les composants Marexcode Web dans le LXC 105.
# À exécuter DANS le 105, depuis la racine du dépôt. --dry-run pour simuler.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "[dry] $*"; else "$@"; fi; }

install -d -m 755 /var/www/marexcode-web
run cp -a "$ROOT/host/lxc105/www/." /var/www/marexcode-web/
run chown -R root:www-data /var/www/marexcode-web
run find /var/www/marexcode-web -type d -exec chmod 755 {} +
run find /var/www/marexcode-web -type f -exec chmod 644 {} +

run install -m 644 "$ROOT"/host/lxc105/nginx/sites-available/*.conf /etc/nginx/sites-available/
run install -m 644 "$ROOT"/host/lxc105/nginx/snippets/*.conf /etc/nginx/snippets/
run install -m 644 "$ROOT"/host/lxc105/nginx/conf.d/*.conf /etc/nginx/conf.d/
for f in marexcode fichiers stats; do
  run ln -sf "/etc/nginx/sites-available/$f.conf" "/etc/nginx/sites-enabled/$f.conf"
done

run install -m 644 "$ROOT"/host/lxc105/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
run install -m 644 "$ROOT"/host/lxc105/fail2ban/jail.d/*.local /etc/fail2ban/jail.d/
run install -m 755 "$ROOT"/host/lxc105/usr/local/sbin/* /usr/local/sbin/

if [ -f "$ROOT/ForkOffline/lxc105/htpasswd" ]; then
  run install -m 640 -o root -g www-data "$ROOT/ForkOffline/lxc105/htpasswd" /etc/nginx/.htpasswd-marexcode
fi

run nginx -t
run /usr/local/sbin/marexcode-web-deploy
run systemctl reload fail2ban || run systemctl restart fail2ban
echo "105 : déployé."
