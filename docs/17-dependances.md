# 17 — Dépendances incluses

Ce bundle est **complet** : les modules et binaires nécessaires au fonctionnement
sont fournis, en plus des configs et de la documentation.

## Modules Node

| Composant | Chemin dans le bundle | Contenu |
|---|---|---|
| Gate / marexws | `deps/lxc102/marexgate/node_modules/` | `@node-rs/argon2` 2.2.2, `@simplewebauthn/server` 14.0.3 + deps |
| Proxy SSH/SFTP | `deps/neva/node24/node_modules/` | `ssh2` ^1.16, `ws` ^8.18 |

Avec ces `node_modules`, **aucun `npm install` n'est nécessaire** pour redémarrer
les services. Les `package.json`/`package-lock.json` sont aussi présents pour
réinstaller proprement si besoin.

## Runtimes / binaires

| Binaire | Chemin dans le bundle | Version | Rôle |
|---|---|---|---|
| Node 102 | `deps/lxc102/bin/node` | 24.21.0 | exécute `marexgate` et `marexws` |
| Node PVE | `deps/neva/node24/bin/node` | 24.22.2 | exécute `marexssh` (portable, peut aussi lancer le gate) |
| Bun | `deps/lxc102/bin/bun` | 1.4.4 | CLI/TUI Marexcode (commande `marexcode`) |
| ttyd | `deps/lxc102/bin/ttyd` | 1.7.7 | terminaux web S1–S4 |
| File Browser | `deps/lxc102/bin/filebrowser` | 2.63.23 | panneau Fichiers |
| Netdata | `deps/lxc102/netdata/netdata`, `deps/lxc102/netdata/lib/` | 2.12.2 | monitoring (état `/var/lib/netdata` hors dépôt) |
| Netdata unit | paquet système `/lib/systemd/system/netdata.service` | — | hors dépôt |
| xterm.js | `host/lxc105/www/vendor/` | 6.0.0 + addon-fit 0.11.0 | terminal SSH de l'iframe |

## Comment les utiliser après restauration

### 102 — gate/ws
```sh
# Option A : restaurer le Node fourni
install -m 755 deps/lxc102/bin/node /usr/bin/node
# Option B : utiliser le Node portable de PVE
#   /opt/marexssh/bin/node /opt/marexgate/server.js
install -d -o marexgate -g marexgate /opt/marexgate
cp -a host/lxc102/opt/marexgate/. /opt/marexgate/
# node_modules est déjà inclus
systemctl restart marexgate marexws
```
- Vérifier : `node --version`, `node /opt/marexgate/server.js` (ou service).
- `node:sqlite` est intégré à Node 24 ; pas de module natif à compiler.

### PVE — marexssh
```sh
install -d -o root -g marexssh /etc/marexssh /var/lib/marexssh
install -m 755 deps/neva/node24/bin/node /opt/marexssh/bin/node
cp -a deps/neva/node24/node_modules /opt/marexssh/
cp host/neva/opt/marexssh/server.js host/neva/opt/marexssh/package*.json /opt/marexssh/
install -m 640 host/neva/etc/marexssh/config.json /etc/marexssh/
install -m 640 ForkOffline/neva/proxy.key /etc/marexssh/
install -m 644 host/neva/etc/systemd/system/marexssh.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now marexssh
```

### 102 — File Browser / Bun / Netdata
```sh
install -m 755 deps/lxc102/bin/filebrowser /usr/local/bin/filebrowser
install -m 755 deps/lxc102/bin/bun /home/sam/.bun/bin/bun   # chown sam
install -m 755 deps/lxc102/netdata/netdata /usr/sbin/netdata
cp -a deps/lxc102/netdata/lib /usr/lib/
# état Netdata : non copié (hors dépôt), recréé par le service
# unit Netdata : fournie par le paquet (hors dépôt)
systemctl daemon-reload
```
- Netdata complet peut aussi être réinstallé via `get.netdata.cloud` ; les configs
  sont dans `/etc/netdata/netdata.conf` (paquet, hors dépôt).
- File Browser : binaire Go, aucune dépendance.

## Architecture / compatibilité

- Binaires **x86_64**, Linux, prévus pour Debian 13 (glibc récente).
- Node/Bun sont liés dynamiquement à `libstdc++`/`libgcc`/`libm`/`libdl` (présents
  sur Debian standard).
- Restaurer sur une autre architecture (ARM) nécessiterait de retélécharger les
  binaires (URLs/versions dans `VERSIONS.txt` et ci-dessus).

## Ce qui reste hors bundle

- L'état Tailscale (`tailscaled.state`) : réauthentifier le nœud.
- Le contenu complet de `/home/sam` (projets, `.config/marex-code`, `.env`, `.ssh`)
  et les volumes Docker : couverts par le `vzdump` LXC 102.
- Les logs.
- Docker/OpenDots/LiteLLM (autres services de 102), non nécessaires à Marexcode Web.

## Ajouts 2026-10-31

- **Monaco** (vendorisé, 105 `vendor/monaco/`) : `monaco.bundle.js` (monaco-editor
  0.57, ESM), `monaco.css`, `editor.worker.js`, `json.worker.js`,
  `codicon-*.ttf`. Reconstruit avec **Bun** (`bun build --format=esm`), pas de CDN.
- **Branding MarexFile** : `/opt/marexfile-branding/` (SVG + PNG générés avec **PIL**
  depuis `/home/sam/venv-cetas` ; pas d'ImageMagick/rsvg sur 102).
- Versions utiles : File Browser **2.63.23**, ttyd **1.7.7**, Netdata **2.12.2**,
  Node **24.x** (102 et PVE), Bun **1.4.x**, nginx **1.26.3** (102).
- Aucun paquet supplémentaire n'est nécessaire pour les thèmes (CSS/JS natif).
