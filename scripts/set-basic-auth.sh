#!/bin/sh
# Définit le mot de passe Basic de la page Marexcode (LXC 105).
# Le mot de passe n'est jamais passé en argument : saisie interactive.
set -eu
[ "$(id -u)" = 0 ] || { echo "à lancer en root sur 105" >&2; exit 1; }
printf 'Utilisateur [marex] : '; read -r USER; USER=${USER:-marex}
printf 'Nouveau mot de passe : '; stty -echo; read -r P1; stty echo; echo
printf 'Confirmer : '; stty -echo; read -r P2; stty echo; echo
[ -n "$P1" ] && [ "$P1" = "$P2" ] || { echo "mots de passe vides ou différents" >&2; exit 1; }
HASH=$(printf '%s' "$P1" | openssl passwd -apr1 -stdin)
printf '%s:%s\n' "$USER" "$HASH" > /etc/nginx/.htpasswd-marexcode
chown root:www-data /etc/nginx/.htpasswd-marexcode
chmod 640 /etc/nginx/.htpasswd-marexcode
unset P1 P2 HASH
nginx -t
systemctl reload nginx
echo "Mot de passe mis à jour pour $USER."
