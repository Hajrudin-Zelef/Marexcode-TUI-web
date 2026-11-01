# 07 — MarexFile (ex-File Browser) et Monitoring (Netdata)

> **MarexFile** est le nouveau nom du panneau Fichiers. Le binaire reste File Browser
> v2.63.23 (archivé), mais l'identité, les couleurs et les performances sont gérées
> par nous. Voir aussi `18-themes.md` et `21-performance.md`.

## MarexFile — rôle

Affiche `/home/sam` du LXC 102 dans un iframe **same-origin** (`/browser/`) de la page.
**Lecture seule** : pas de création, renommage, modification, suppression, exécution ni
partage ; le téléchargement reste autorisé.

## Service

```ini
# /etc/systemd/system/filebrowser-marexcode.service
User=sam
ExecStart=/usr/local/bin/filebrowser -b /browser -r /home/sam -p 8082 -a 127.0.0.1 \
  --noauth -d /home/sam/.filebrowser.db \
  --disableThumbnails --disableImageResolutionCalc
Restart=always
```

- Binaire : `/usr/local/bin/filebrowser` **v2.63.23** (projet archivé, plus de patchs).
- `-b /browser` obligatoire (ne pas utiliser `/files`, route interne).
- `-a 127.0.0.1` : joignable seulement depuis 102.
- `--noauth` : l'auth est faite par nginx/gate en amont ; ne pas recréer la DB.
- `--disableThumbnails --disableImageResolutionCalc` : listings plus rapides
  (les aperçus d'images ouvrent toujours l'original).
- `.filebrowser.db` : admin, `singleClick`, `viewMode=list`, permissions en lecture
  seule, `Download=true`, `hideDotfiles`.

## Branding « MarexFile »

- Dossier `/opt/marexfile-branding/` (755 root:root, fichiers 644) :
  - `img/logo.svg` — monogramme **MF** (M blanc, F menthe, carré sombre arrondi) ;
  - `img/icons/` — `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` (180),
    `android-chrome-192/512` ;
  - `custom.css` — force le logo dans l'en-tête même en panneau étroit (~300 px).
- Réglages appliqués dans la base (service arrêté 2 s) :

```sh
filebrowser -d /home/sam/.filebrowser.db config set \
  --branding.name "MarexFile" \
  --branding.files /opt/marexfile-branding \
  --branding.disableExternal
```

- Effets : titre `… - MarexFile`, manifeste dynamique, logo/favicons, **liens GitHub
  masqués**. Les favicons sont servis à `/browser/static/img/icons/*`.
- Les couleurs ne viennent **pas** du branding : elles sont injectées par la page
  (`syncFileBrowserTheme`) selon le thème actif.

### Vérifier / réparer

```sh
systemctl stop filebrowser-marexcode
/usr/local/bin/filebrowser -d /home/sam/.filebrowser.db config cat | sed -n '/Branding/,/Server/p'
/usr/local/bin/filebrowser -d /home/sam/.filebrowser.db users ls
systemctl start filebrowser-marexcode
```

## Montage, thème et aperçu

- 102 : `/browser/` → `127.0.0.1:8082`, `auth_request` + `client_max_body_size 2g`.
- **Statique** (`/browser/static/`) : servi **sans gate**, avec cache long
  (`assets/` 1 an immutable, `img/` 1 jour, `custom.css` no-cache) — voir `21-performance.md`.
- Dotfiles : `location ~ ^/browser/.*/\.` → `404`.
- La page capture les clics dans l'iframe et ouvre **sa visionneuse** via
  `/browser/api/raw/<chemin>?inline=true` + `/api/resources` (texte/code en `<pre>`,
  médias natifs, binaire > 8 Mo → téléchargement).
- Thème : `syncFileBrowserTheme()` injecte `#marex-fb-theme` (variables
  `--surfacePrimary`, `--textPrimary`, `--blue`, `.item`, header, breadcrumbs,
  sélection) à chaque changement de thème et au chargement de l'iframe.

## Pièges

- 401 dans l'iframe = cross-origin (ancien `https://fichiers...`) → toujours `/browser/`.
- Clic qui sélectionne seulement = `singleClick=false` ; grosses icônes = `viewMode`
  non `list` → corriger avec `users update` (ci-dessus).
- 403 « permissions » sur `.agents` = un `location ~ /\.` ; il a été retiré.
- `/browser/files/.ssh` → 404 (normal).
- `custom.css` en `no-cache` : après modification, recharger la page (pas de cache 1 an).
- Ne pas recréer `.filebrowser.db` : on perdrait permissions, branding et réglages.

## Netdata

### Rôle
Source de métriques. La page n'affiche **qu'une ligne** en bas (`#monbar`) : CPU, RAM
(utilisé/total, %), disque (utilisé/total, %), réseau ↓/↑, load1, uptime — avec de
petites icônes SVG. Le dashboard complet reste accessible sur `stats.example.com`.

### Installation / service

- Installé via le script officiel (`get.netdata.cloud`, stable, sans télémétrie).
- `/etc/netdata/netdata.conf` :

```ini
[web]
    bind to = 127.0.0.1:19999
```

- Service `netdata`, uniquement loopback → exposé via le vhost `stats` (105) et
  `/metrics/` (proxy 105 → 102 vhost stats → 19999).
- Version : 2.12.2.

### API utilisée par la barre

```
/metrics/api/v1/data?chart=system.cpu&after=-1&points=1&format=json&group=average
```

Autres charts : `system.ram`, `disk_space./`, `system.net`, `system.load`, `system.uptime`.
Unités : RAM en **MiB**, disque en **GiB**, réseau en **kilobits/s** (convertis en Mb/s),
`idle` absent sur Netdata 2.x (somme des dimensions = usage). Poll 3 s, pause onglet caché.

### Sécurité
`/metrics/` protégé par le Basic auth de la page ; `stats.example.com` par Basic auth ;
Netdata jamais exposé sans auth.

### Pièges
- Netdata sur `0.0.0.0` par défaut → remettre `bind to = 127.0.0.1:19999`.
- Ne pas remettre le dashboard en iframe (refus X-Frame-Options).
- `Disque 0/0` = erreur d'unité (GiB vs octets) ; le code affiche `47/69 Go`.
- Réseau en Ko/s vs Mb/s : `system.net` est en kilobits/s.
