#!/bin/sh
# Installe les prérequis Marexcode Web dans le LXC 105.
# nginx, certbot, fail2ban.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx fail2ban openssl >/dev/null
mkdir -p /var/www/certbot
echo "105 : prérequis installés. Lancer scripts/deploy-105.sh"
