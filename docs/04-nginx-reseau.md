# 04 — Nginx, réseau, TLS, Tailscale

## Chaîne publique

```
client → 203.0.113.10:443
      → PVE nginx stream (:443, SNI)
      → 10.0.0.105:443 (TLS terminé, PROXY protocol)
      → 10.0.0.102:80 (nginx 102)
```

### PVE — routeur SNI (stream)

Fichiers : `/etc/nginx/stream-conf.d/stream-router.conf`,
`/etc/nginx/router-map.stream`, `/etc/nginx/router-map.http`,
`/etc/nginx/sites-available/router`.

```nginx
stream {
    map $ssl_preread_server_name $tls_backend {
        include /etc/nginx/router-map.stream;
        default 10.0.0.105:443;
    }
    server {
        listen 443;
        ssl_preread on;
        proxy_pass $tls_backend;
        proxy_protocol on;          # ← indispensable : 105 écoute en proxy_protocol
        proxy_connect_timeout 5s;
        proxy_timeout 30s;
    }
}
```

- `router-map.stream` mappe les domaines connus vers 105:443 (cetas, nws, nsweb…).
- **Tout domaine non listé** va par défaut à 105:443 : c'est ainsi que
  `marexcode`, `fichiers`, `stats` arrivent à 105 sans entrée dédiée.
- **PROXY protocol** : si on l'enlève côté PVE ou côté 105, les `listen 443`
  de 105 ne comprennent plus la connexion → erreur 400/fermeture. Les deux côtés
  doivent rester cohérents.
- Le vhost HTTP (`sites-available/router`) route le port 80 par Host vers 105:80.

### 105 — terminaison TLS et reverse proxy

Fichier : `/etc/nginx/sites-available/marexcode.conf` (+ `fichiers.conf`,
`stats.conf`). Chaque serveur `443` utilise :

```nginx
listen 443 ssl http2 proxy_protocol;
set_real_ip_from 10.0.0.1;
real_ip_header proxy_protocol;
auth_basic "Marexcode";
auth_basic_user_file /etc/nginx/.htpasswd-marexcode;
limit_req zone=ttyd burst=50 nodelay;
access_log /var/log/nginx/marexcode.access.log;
```

Ordre des locations du vhost `marexcode` :

| Location | Cible | Particularité |
|---|---|---|
| `= /` et `= /index.html` | page locale | CSP + en-têtes (snippets), `try_files /index.html` |
| `= /gate/verify` | `404` | ne jamais exposer la vérification |
| `/gate/` | `http://10.0.0.102:80` | `limit_req zone=gate burst=10` |
| `/terminal/` | `102:80` | WS, `X-Remote-User $remote_user`, timeouts 86400 |
| `/browser/` | `102:80` | same-origin, body 2g, WS |
| `/metrics/` | `102:80` avec `Host: stats.example.com` | API Netdata |
| `= /ssh-ui` / `/ssh-ui/` | page locale (HTTP ts.net) ; **404 sur le vhost HTTPS public** | CSP propre |

- `/metrics/` proxifie vers le vhost `stats` de 102 (Netdata).
- Les vhosts `fichiers` et `stats` (HTTPS) existent pour les certificats ; `fichiers`
  redirige 301 vers la page (accès direct non gaté supprimé), `stats` sert Netdata direct.
- Le serveur HTTP `neva.example-tailnet.ts.net` (port 80, alimenté par Tailscale Serve)
  sert aussi la page et `/ssh-ui/`.

### 102 — vhosts internes

Fichiers : `/etc/nginx/conf.d/{marexcode,fichiers,stats}.conf`.
Accès limité : `allow 10.0.0.105; allow 127.0.0.1; deny all;` (le `.1` a été
retiré du web ; seul `/_gate/verify-neva` accepte `10.0.0.1`).

| Location | Cible |
|---|---|
| `/terminal/1..4/` | `marexws` `127.0.0.1:7691..7694` + `auth_request /_gate/verify` |
| `/browser/` | File Browser `127.0.0.1:8082` + `auth_request` |
| `/gate/` | `127.0.0.1:8789` |
| `/_gate/verify` | interne (`auth_request`), proxy `/verify` |
| `/_gate/verify-neva` | allow `10.0.0.1` uniquement (revalidation SSH) |
| `/metrics/` (stats) | `127.0.0.1:19999` |
| `~ ^/browser/.*/\.` | `404` (dotfiles) |

- `auth_request` renvoie 401 si le cookie `__Host-marexgate` est absent/expiré/révoqué.
- `X-Remote-User` est indispensable à ttyd (`-H`) ; 105 le pose depuis `$remote_user`.

## Domaines, DNS et certificats

| Domaine | Rôle | Cert |
|---|---|---|
| `marexcode.example.com` | page principale | Let's Encrypt |
| `fichiers.example.com` | redirige 301 vers la page | Let's Encrypt (conservé) |
| `stats.example.com` | Netdata direct | Let's Encrypt (conservé) |
| `neva.example-tailnet.ts.net` | fallback Tailscale + SSH | Tailscale (auto) |

- DNS : A `203.0.113.10` pour les trois `.example.com`.
- `certbot certonly --webroot -w /var/www/certbot -d <domaine>` sur 105.
- Renouvellement : timer certbot ; `certbot certificates`, `renew --dry-run`.
- HSTS sur 105 (page). Certificats valides jusqu'au 2027-01-28.

## Tailscale Serve (fallback + SSH)

Sur PVE :

```
https://neva.example-tailnet.ts.net:8443
  ├── /    → http://10.0.0.105:80
  └── /ssh → http://127.0.0.1:8791   (marexssh)
```

- `tailscale serve status` pour vérifier ; `tailscale serve --https=8443 off` pour tout couper.
- Serve injecte `Tailscale-User-Login` (identité admin `<admin-tailscale>`) et
  supprime toute valeur client.
- Le nœud annonce les routes `10.0.0.0/24`, `10.0.2.0/24`, `192.168.1.0/24`.
  Le garde-fou 102:22 a existé puis a été **désactivé le 2026-10-31** (accès direct rétabli).
- **L'état Tailscale n'est pas dans le bundle** : après réinstallation, il faut
  réauthentifier le nœud et recréer le Serve (`tailscale serve --bg --https=8443 ...`).

## Garde-fou tailnet → 102:22 (désactivé)

- La règle `iptables -I FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp --dport 22 -j DROP`
  et le timer `marex-tailnet-guard.timer` ont été **désactivés le 2026-10-31** :
  accès SSH direct tailnet → 102:22 **rétabli**.
- Les fichiers `/usr/local/sbin/marex-tailnet-guard` et les unités restent sur disque,
  **disabled** ; ne pas les réactiver sans raison.
- Le proxy SSH web (`marexssh`) n'en dépend pas.

## Debug réseau

```sh
# DNS
dig +short marexcode.example.com
# TLS / headers
curl -skI https://marexcode.example.com/            # 401 attendu sans Basic
curl -skI -u marex:... https://marexcode.example.com/
# routage interne
pct exec 105 -- curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: marexcode.example.com' http://10.0.0.102/
pct exec 102 -- curl -s http://127.0.0.1:8789/health
# Tailscale
tailscale serve status
# logs
pct exec 105 -- tail -f /var/log/nginx/marexcode.access.log
pct exec 105 -- tail -f /var/log/nginx/error.log
```

## Modifier un vhost

1. Éditer `/etc/nginx/sites-available/<nom>.conf` (105 ou 102).
2. `nginx -t` puis `systemctl reload nginx` **sur la machine concernée**.
3. Si la page change : `pct exec 105 -- /usr/local/sbin/marexcode-web-deploy`.
4. Si 105 change : penser à `limit_req`, `realip`, `access_log` partagé et Basic auth
   (sinon fail2ban/IP réelle cassés).

## Pièges réseau (déjà rencontrés)

- **PROXY protocol absent d'un côté** → 400/fermeture ; les `listen 443` de 105
  doivent garder `proxy_protocol`.
- **105 ne peut pas joindre `127.0.0.1:...` de 102** : toujours passer par
  `10.0.0.102:80`.
- **Sans `real_ip`**, toutes les IP vues par fail2ban = 10.0.0.1 → bans inutiles.
- **Rate limit trop bas** (5 r/s) → 503/429 sur la page (iframe + WS + métriques).
  Garder `ttyd` 20 r/s burst 50.
- **Ajouter un domaine** : ajouter la route dans `router-map.stream` **et**
  `router-map.http` (ou compter sur le défaut 105), créer le vhost 105 + cert.
- **Supprimer le bloc `location ~ /\.`** des vhosts : il cassait l'accès aux
  dossiers cachés de `/home/sam` (403 « You don't have permissions »).

## Mise à jour 2026-10-31 — cache, gzip, gate

### 102
- `upstream marexfb` (127.0.0.1:8082) + `keepalive 16`.
- `gzip on/vary/proxied` + types.
- `/browser/static/` : locations **sans `auth_request`** (public), buffering on,
  cache long, `proxy_hide_header Cache-Control`, `Connection ""`.
- `/browser/` (HTML) et `/browser/api/` restent gatés.

### 105
- `upstream marexweb` (10.0.0.102:80) + `keepalive 16`.
- Mêmes locations statiques sur les deux serveurs (HTTP ts.net + HTTPS),
  `auth_basic off` pour les assets, `proxy_hide_header` des doublons, gzip.
- Le `Cache-Control: no-store` de niveau serveur ne s'applique plus aux assets.

### Vérifications
```sh
curl -sI https://marexcode.example.com/browser/static/assets/index-BOEsmRAc.css
# cache-control: public, max-age=31536000, immutable ; content-encoding: gzip (si accept)
curl -s -o /dev/null -w '%{http_code}\n' https://marexcode.example.com/browser/api/resources/marexcode
# 401 sans cookie
```
