# 12 — Sauvegarde et restauration

## Ce qui existe déjà (PVE)

### 1. `vzdump` quotidien — tous les LXC
- Job PVE (`/etc/pve/jobs.cfg`) : **21:00**, `all 1`, `mode snapshot`, `zstd`,
  `keep-last=3`, stockage **`backup` = `/mnt/backup`** (137 Go, ~97 Go utilisés).
- Couvre **102, 104, 105, 106, 107, 108** (LXC complets, rootfs).
- 102 : ~22–23 Go/archive ; 105 : ~519 Mo ; les autres < 3,1 Go.
- Logs : `/mnt/backup/dump/*.log` ; notes `.notes` ; vérifier chaque jour.
- **Attention** : archive de 23 Go, restauration d'un seul fichier = extraction
  (ou utiliser le bundle / un backup fichier). Et **même disque physique**, pas de
  hors-site.

### 2. Config PVE quotidienne
- `/usr/local/bin/backup-pve-config.sh` (cron **03:00**) → `/root/pve-config-backups/`
  (14 versions, Telegram). Couvre `/etc/pve`, `/etc/network/interfaces`, `/etc/fail2ban`,
  postfix, `/usr/local/bin/*.sh`, crontabs.
- **Ne couvre pas** `/etc/nginx` (routeur), `/opt/marexssh`, `/etc/marexssh`,
  `/var/lib/marexssh`, les units, `/home/sam/.operator`, l'état Tailscale.

### 3. Ce bundle (`marex-web-...tar.zst`)
- Documentation complète + **tous les fichiers de configuration/code/DB** de
  Marexcode Web (PVE + 102 + 105), y compris les secrets (voir `15-secrets.md`).
- `MANIFEST.sha256` pour vérifier l'intégrité.
- Ce n'est **pas** un remplacement des `vzdump` : c'est la copie lisible/portable.

### 4. Anciens backups de phase
- 102/105/PVE : `/root/*.bak-*`, `phase3-gate-backup/`, `phase4-gate-backup.db`,
  `p6-*`, `p7-*`… (petits fichiers ; archives de phase **hors dépôt**).

## Ce qui n'est pas couvert par ce bundle
- L'état Tailscale (`/var/lib/tailscale/tailscaled.state`) → réauthentifier.
- Le contenu complet de `/home/sam` et les volumes Docker (→ `vzdump`).
- Les logs (non essentiels ; audit inclus).
- `node_modules`, Node 24, Bun, File Browser et Netdata **sont inclus** (voir `17-dependances.md`).

## Restaurer un LXC complet (recommandé pour un désastre)

> Ne **jamais** restaurer par-dessus un LXC en production sans sauvegarde préalable.
> Tester d'abord sur un nouvel ID.

```sh
# 1) vérifier l'archive
ls -lh /mnt/backup/dump/vzdump-lxc-102-*.tar.zst
zstd -t /mnt/backup/dump/vzdump-lxc-102-....tar.zst   # ou tar -tzf
# 2) restaurer vers un nouvel ID (ex. 999) pour vérifier
pct restore 999 /mnt/backup/dump/vzdump-lxc-102-....tar.zst --storage local-lvm
# 3) démarrer le clone, tester, puis basculer (arrêt de 102 + restore 102 + start)
```
- Le `vzdump` contient le rootfs complet (OS, `/home/sam`, Docker, `/opt`, `/var`, `/etc`).
- Après restauration : vérifier les IP (`net0`), le MTU 1500, les services
  (`marexgate`, `marexws`, ttyd, File Browser, Netdata), et le cookie/gate.
- Restaurer **105** de la même façon (page, nginx, certs, fail2ban).
- PVE (hôte) : pas de `vzdump` ; utiliser ce bundle + `pve-config-backups`.

## Restaurer uniquement la config web (sans LXC)

Depuis le bundle décompressé :

### 102
```sh
pct push 102 host/lxc102/opt/marexgate/server.js /opt/marexgate/server.js
# ... lib.js, webauthn.js, marexws.js, cli.js, package.json, package-lock.json
# node_modules est fourni dans le bundle :
pct exec 102 -- mkdir -p /opt/marexgate
pct push 102 deps/lxc102/marexgate/node_modules /opt/marexgate/node_modules
pct exec 102 -- sh -c 'systemctl restart marexgate marexws'
# (ou : cd /opt/marexgate && npm ci)
# units
pct push 102 host/lxc102/etc/systemd/system/marexgate.service /etc/systemd/system/
# ... autres units, puis daemon-reload + enable --now
# nginx
pct push 102 host/lxc102/etc/nginx/conf.d/marexcode.conf /etc/nginx/conf.d/
pct exec 102 -- sh -c 'nginx -t && systemctl reload nginx'
# DB du portail (snapshot cohérent fourni)
pct exec 102 -- systemctl stop marexgate
pct push 102 ForkOffline/lxc102/gate.db /var/lib/marexgate/gate.db
pct exec 102 -- sh -c 'chown marexgate:marexgate /var/lib/marexgate/gate.db; chmod 600 /var/lib/marexgate/gate.db; systemctl start marexgate'
```
- `gate.db` du bundle = **VACUUM INTO** (cohérent, WAL intégré).
- Si tu restaures une ancienne DB brute, il faut aussi ses `-wal`/`-shm` (ou arrêter
  le service avant la copie).

### 105
```sh
pct push 105 host/lxc105/www/index.html /var/www/marexcode-web/index.html
# ssh-ui/, vendor/...
pct push 105 host/lxc105/nginx/sites-available/marexcode.conf /etc/nginx/sites-available/
# ... snippets, ratelimit, htpasswd, fail2ban
pct exec 105 -- sh -c 'ln -sf /etc/nginx/sites-available/marexcode.conf /etc/nginx/sites-enabled/marexcode.conf; nginx -t && systemctl reload nginx'
pct exec 105 -- /usr/local/sbin/marexcode-web-deploy
```
- Certificats : recopier `/etc/letsencrypt` **ou** `certbot certonly`.
- `.htpasswd-marexcode` : remettre en 0640 root:www-data.
- Si les hachages CSP ne correspondent plus : `marexcode-web-deploy` (obligatoire).

### PVE (hôte)
```sh
# nginx routeur
install -m 644 host/neva/nginx/router-map.stream /etc/nginx/router-map.stream
install -m 644 host/neva/nginx/router-map.http /etc/nginx/router-map.http
install -m 644 host/neva/nginx/stream-router.conf /etc/nginx/stream-conf.d/
install -m 644 host/neva/nginx/router /etc/nginx/sites-available/router
ln -sf /etc/nginx/sites-available/router /etc/nginx/sites-enabled/router
nginx -t && systemctl reload nginx
# marexssh
install -m 644 host/neva/opt/marexssh/server.js /opt/marexssh/
cp host/neva/opt/marexssh/package*.json /opt/marexssh/
cd /opt/marexssh && PATH=/opt/marexssh/bin:$PATH npm ci
install -m 640 host/neva/etc/marexssh/config.json /etc/marexssh/
install -m 640 ForkOffline/neva/proxy.key /etc/marexssh/
install -m 644 host/neva/etc/systemd/system/marexssh.service /etc/systemd/system/
install -m 750 host/neva/usr/local/sbin/marexssh /usr/local/sbin/
systemctl daemon-reload && systemctl enable --now marexssh
tailscale serve --bg --https=8443 --set-path=/ssh http://127.0.0.1:8791
# garde-fou (facultatif, DÉSACTIVÉ le 2026-10-31) : ne pas l'activer si tu veux
# garder l'accès SSH direct tailnet → 102:22.
# install -m 750 host/neva/usr/local/sbin/marex-tailnet-guard /usr/local/sbin/
# install -m 644 host/neva/etc/systemd/system/marex-tailnet-guard.service /etc/systemd/system/
# install -m 644 host/neva/etc/systemd/system/marex-tailnet-guard.timer /etc/systemd/system/
# systemctl daemon-reload && systemctl enable --now marex-tailnet-guard.timer
```

## Restaurer le portail après une perte de DB
- Le snapshot `gate.db` contient **maître + appareils + passkeys**. Restauré tel quel,
  les sessions/appareils existants redeviennent valides (sauf ceux expirés).
- Si tu veux repartir propre : `sudo marexgate reset` puis `passwd`.
- Ne jamais copier un `.db` seul d'un service **en marche** (WAL) : utiliser
  `VACUUM INTO` ou arrêter le service.

## Hors-site (recommandation)

Actuellement : **aucun hors-site**. Le serveur et les backups sont sur le même hôte.
Options :
1. Copier les dernières archives `vzdump` + ce bundle vers **MEGA** (client installé
   mais non connecté) ou un autre stockage ;
2. Chiffrer avant envoi (`age`, `gpg`, ou archive chiffrée) ;
3. Vérifier périodiquement la restauration.

## Tester une sauvegarde (à faire régulièrement)

```sh
# intégrité de l'archive
zstd -t /mnt/backup/dump/vzdump-lxc-102-....tar.zst
# vérifier le bundle
sha256sum -c MANIFEST.sha256
# restauration test sur un nouvel ID
pct restore 999 <archive> --storage local-lvm && pct start 999
```
Ne pas laisser le clone 999 tourner (adresses/IP, services). Le supprimer après test.

## Ce que ce bundle permet de restaurer sans LXC
- Page web + iframe + xterm + CSP.
- Toutes les configs nginx (routeur PVE, 105, 102).
- Gate + marexws + DB + clés HMAC + alertes.
- ttyd/marex-tmux/marexcode + units + profil.
- File Browser DB.
- Netdata config.
- SSH proxy + config + known_hosts + audit.
- Certs, fail2ban, helpers de déploiement.

## Compléments 2026-10-31

Le bundle inclut désormais :
- `/opt/marexfile-branding/` (logo MF, favicons, `custom.css`) ;
- `/var/www/marexcode-web/vendor/monaco/` (bundle + workers + police) ;
- les sources PVE de la page, du panneau SSH et des vendors Monaco ;
- les vhosts nginx 105/102 avec les locations de cache/gzip ;
- `.filebrowser.db` (permissions + branding) et `gate.db` (snapshot cohérent) ;
- les unités `filebrowser-marexcode`, `marexgate`, `marexws`, `ttyd@`, `netdata`.

Restauration minimale après un `pct restore` (si besoin) :
```sh
# 102
cp -a host/lxc102/opt/marexfile-branding /opt/
cp -a ForkOffline/lxc102/gate.db /var/lib/marexgate/
cp -a ForkOffline/lxc102/filebrowser.db /home/sam/
# 105
cp -a host/lxc105/www /var/www/
# PVE
cp -a host/neva/home/sam/marexcode-web-* /home/sam/
```
Puis `nginx -t && systemctl reload nginx`, `daemon-reload`, restart des services.
`marexcode-web-deploy` régénère la CSP de la page.

> Le bundle précédent (`…-2026-10-31-complet.tar.gz`) est **antérieur** à MarexFile,
> aux thèmes, à Monaco et aux optimisations : ne pas l'utiliser pour restaurer l'UI.
