# 02 — Inventaire : où sont les fichiers

Ce document décrit l'arborescence **du dépôt** et, pour chaque élément, le chemin
**réel** sur la machine correspondante. Les secrets et les binaires sont hors dépôt
(voir `15-secrets.md` et `17-dependances.md`).

## Le dépôt (`marexcode-web/`)

```
app/                       sources de l'interface
├── index.html             page complète (HTML + CSS + JS inline)
├── ssh-ui/                iframe SSH : index.html + app.js
└── vendor/                xterm.js, xterm.css, addon-fit.js, monaco/

host/neva/                 hôte Proxmox
├── opt/marexssh/          server.js, package.json, package-lock.json
├── etc/marexssh/          config.json (admins, CIDR, limites)
├── etc/systemd/system/    marexssh.service, marex-tailnet-guard.{service,timer}
├── usr/local/sbin/        marexssh, marex-tailnet-guard
└── nginx/                 stream-router.conf, router-map.{stream,http}, router

host/lxc102/               application
├── opt/marexgate/         server.js, lib.js, webauthn.js, marexws.js, cli.js
├── opt/marexfile-branding/ logo MF, favicons, custom.css
├── etc/marexcode/         security.json
├── etc/nginx/conf.d/      marexcode.conf, marexcode-map.conf, fichiers.conf, stats.conf
├── etc/nginx/snippets/    ttyd-proxy.conf
├── etc/systemd/system/    marexgate, marexws, ttyd-marexcode@, filebrowser-marexcode
├── etc/logrotate.d/       marexgate
└── usr/local/bin/         marexgate, marex-tmux, marexcode

host/lxc105/               exposition web
├── www/                   index.html + ssh-ui/ + vendor/ (copie déployée)
├── nginx/sites-available/ marexcode.conf, fichiers.conf, stats.conf
├── nginx/snippets/        marexcode-csp.conf, page-headers{,-https}.conf
├── nginx/conf.d/          ttyd-ratelimit.conf
├── fail2ban/filter.d/     nginx-ttyd.conf, nginx-marexgate.conf
├── fail2ban/jail.d/       nginx-ttyd.local, nginx-marexgate.local
└── usr/local/sbin/        marexcode-csp.py, marexcode-web-deploy

docs/                      26 documents (00 → 25)
reference/                 plans + specs Operator
scripts/                   install, deploy, verify, backup, restore-check, auth
deps/                      binaires (hors git)
ForkOffline/               secrets et bases (hors git, 0700)
```

## Correspondance dépôt → machine

### PVE (hôte Proxmox)

| Dépôt | Chemin réel |
|---|---|
| `host/neva/opt/marexssh/*.js` | `/opt/marexssh/` |
| `host/neva/etc/marexssh/config.json` | `/etc/marexssh/config.json` |
| `host/neva/etc/systemd/system/marexssh.service` | `/etc/systemd/system/` |
| `host/neva/etc/systemd/system/marex-tailnet-guard.*` | `/etc/systemd/system/` |
| `host/neva/usr/local/sbin/marexssh` | `/usr/local/sbin/marexssh` |
| `host/neva/usr/local/sbin/marex-tailnet-guard` | `/usr/local/sbin/marex-tailnet-guard` |
| `host/neva/nginx/stream-router.conf` | `/etc/nginx/stream-conf.d/stream-router.conf` |
| `host/neva/nginx/router-map.stream`, `.http` | `/etc/nginx/` |
| `host/neva/nginx/router` | `/etc/nginx/sites-available/router` |
| `deps/neva/node24/` | `/opt/marexssh/{bin,lib,node_modules}` |
| `ForkOffline/neva/proxy.key` | `/etc/marexssh/proxy.key` |

Non inclus (hors dépôt) : `/etc/nginx/nginx.conf` complet, `/var/lib/marexssh/`,
`/etc/fail2ban/` de l'hôte, `/etc/network/interfaces`, `/etc/pve/*`,
`/root/pve-config-backups/`, `/var/lib/tailscale/tailscaled.state`.

### LXC 102 (`app-lxc`, 10.0.0.102)

| Dépôt | Chemin réel |
|---|---|
| `host/lxc102/opt/marexgate/*.js` | `/opt/marexgate/` |
| `host/lxc102/opt/marexfile-branding/` | `/opt/marexfile-branding/` |
| `host/lxc102/etc/marexcode/security.json` | `/etc/marexcode/security.json` |
| `host/lxc102/etc/nginx/conf.d/*.conf` | `/etc/nginx/conf.d/` |
| `host/lxc102/etc/nginx/snippets/ttyd-proxy.conf` | `/etc/nginx/snippets/` |
| `host/lxc102/etc/systemd/system/*.service` | `/etc/systemd/system/` |
| `host/lxc102/etc/logrotate.d/marexgate` | `/etc/logrotate.d/` |
| `host/lxc102/usr/local/bin/{marexgate,marex-tmux,marexcode}` | `/usr/local/bin/` |
| `deps/lxc102/bin/{node,filebrowser,ttyd,bun}` | `/usr/bin/node`, `/usr/local/bin/{filebrowser,ttyd}`, `/home/sam/.bun/bin/bun` |
| `deps/lxc102/netdata/` | `/usr/sbin/netdata`, `/usr/lib/netdata` |
| `deps/lxc102/marexgate/node_modules` | `/opt/marexgate/node_modules` |
| `ForkOffline/lxc102/proxy.key` | `/etc/marexcode/proxy.key` |
| `ForkOffline/lxc102/alerts.env` | `/etc/marexcode/alerts.env` |
| `ForkOffline/lxc102/gate.db` | `/var/lib/marexgate/gate.db` |
| `ForkOffline/lxc102/filebrowser.db` | `/home/sam/.filebrowser.db` |

Non inclus : `/home/sam` (projets, ~23 Go), volumes Docker, `/var/lib/netdata`,
`/etc/netdata/netdata.conf`, `/var/lib/marexgate/audit.jsonl`, `.env` des projets.

### LXC 105 (`web-lxc`, 10.0.0.105)

| Dépôt | Chemin réel |
|---|---|
| `host/lxc105/www/` | `/var/www/marexcode-web/` |
| `host/lxc105/nginx/sites-available/*.conf` | `/etc/nginx/sites-available/` |
| `host/lxc105/nginx/snippets/*.conf` | `/etc/nginx/snippets/` |
| `host/lxc105/nginx/conf.d/ttyd-ratelimit.conf` | `/etc/nginx/conf.d/` |
| `host/lxc105/fail2ban/filter.d/*.conf` | `/etc/fail2ban/filter.d/` |
| `host/lxc105/fail2ban/jail.d/*.local` | `/etc/fail2ban/jail.d/` |
| `host/lxc105/usr/local/sbin/*` | `/usr/local/sbin/` |
| `ForkOffline/lxc105/htpasswd` | `/etc/nginx/.htpasswd-marexcode` |
| `ForkOffline/lxc105/letsencrypt/` | `/etc/letsencrypt/` |

Non inclus : `/var/www/certbot/` (vide), `/var/log/nginx/`.

## Journaux utiles

| Où | Quoi |
|---|---|
| 102 `/var/lib/marexgate/audit.jsonl` | logins, appareils, step-up, tickets SSH, alertes |
| PVE `/var/lib/marexssh/audit.jsonl` | WS SSH, connexions, host keys, uploads, révocations |
| 105 `/var/log/nginx/marexcode.access.log` | requêtes page/gate/terminal/browser + fail2ban |
| 102 `/var/log/nginx/marexcode.access.log` | requêtes internes 105→102 |
| `journalctl -u marexgate|marexws|marexssh` | logs applicatifs |
| `journalctl -u nginx` (102/105/PVE) | erreurs nginx |

## Bases et fichiers d'état

- `gate.db` (SQLite WAL) : `settings`, `devices`, `webauthn_credentials`, `audit`.
- `filebrowser.db` (SQLite) : utilisateur `admin`, permissions, vue, clic simple.
- `known_hosts.json` : empreintes SSH par `hôte:port` (hors dépôt).
- `tailscaled.state` : identité du nœud + config Serve (hors dépôt).
- OpenDots `data/opendots.sqlite` (+WAL), volumes Docker (hors dépôt, dans 102).

## Ce qui n'est pas dans le dépôt

- Le contenu complet de `/home/sam` sur 102 et les volumes Docker.
- L'état Tailscale et les sauvegardes `vzdump` (97 Go).
- Les logs, les modèles LLM, les environnements virtuels.
- Les anciennes archives de phase (`*.bak-*`, `*.tar.gz`).
