# 21 — Performance de MarexFile (File Browser)

## Diagnostic (phase 0, 2026-10-31)

Mesures Playwright (Chromium headless, auth émulée) :

| Contexte | Page (DCL) | Page transfert | Fichiers (DCL) | Fichiers transfert |
|---|---|---|---|---|
| Desktop froid | 96 ms | 225 Ko | 238 ms | **671 Ko** |
| Desktop « chaud » | 42 ms | 225 Ko | 101 ms | **671 Ko** (aucun cache) |
| Mobile froid | 86 ms | 225 Ko | 228 ms | **499 Ko** |

- Listing API : 6–7 ms, 4 418 o, **non compressé** à l'époque.
- **Cause principale** : le vhost 105 envoyait `Cache-Control: no-store` au niveau
  `server`, valeur **héritée par `/browser/`** → aucun cache navigateur, tout
  retéléchargé à chaque visite.
- Le serveur lui-même est rapide (index 0,5 ms) ; le coût est le téléchargement +
  démarrage de Vue.

## Changements appliqués

### Nginx 102 (`/etc/nginx/conf.d/marexcode.conf`)

- `upstream marexfb { server 127.0.0.1:8082; keepalive 16; }`
- `gzip on; gzip_vary on; gzip_proxied any; gzip_types …;`
- Locations statiques **sans `auth_request`** :
  - `= /browser/static/custom.css` → `no-cache, must-revalidate`
  - `^~ /browser/static/assets/` → `public, max-age=31536000, immutable`
  - `^~ /browser/static/img/` → `public, max-age=86400`
  - `^~ /browser/static/` → `public, max-age=3600`
  - `proxy_hide_header Cache-Control/Vary/X-CTO`, `proxy_buffering on`,
    `proxy_set_header Connection ""`.
- HTML et API restent **gatés** (`auth_request`).

### Nginx 105 (vhost marexcode, HTTP ts.net + HTTPS)

- `upstream marexweb { server 10.0.0.102:80; keepalive 16; }`
- Mêmes locations statiques, `auth_basic off` (assets publics), cache long,
  `proxy_hide_header` des doublons, gzip sur les deux serveurs.

### File Browser

- `--disableThumbnails --disableImageResolutionCalc` (unit).
- Base, branding et permissions inchangés.

## Résultats (froid)

| | Avant | Après |
|---|---|---|
| Desktop Fichiers | 671 Ko | **636 Ko** |
| Mobile Fichiers | 499 Ko | **459 Ko** |
| CSS | 66 934 o | **22 174 o** (gzip) |
| JSON listings | non compressé | **gzip** |
| Requêtes statiques | passaient par le gate | **200 sans cookie** |

## Vérifier le cache

Playwright avec `http_credentials` (auth Basic émulée) **désactive le cache** de
Chromium — vérifié : avec credentials, jamais « from disk cache » ; sans, oui.
Donc le gain des rechargements ne se mesure pas ici.

Dans un vrai navigateur : onglet **Réseau**, recharger deux fois, colonne
**from disk cache** pour les fichiers de `assets/`. Les en-têtes servis sont :

```
cache-control: public, max-age=31536000, immutable
content-encoding: gzip        (CSS/JSON)
```

## Rollback

- Nginx : `/root/marexfile-backup/pre-perf-102.conf`, `pre-perf-105.conf`.
- File Browser : `/root/marexfile-backup/pre-perf-filebrowser.service`.
- `nginx -t && systemctl reload nginx` (102 et 105), `daemon-reload` + restart FB.

## Limite structurelle

Le vrai « instantané » serait un **panneau MarexFile natif** (sans iframe ni Vue).
C’est une option future, hors périmètre de ce bundle.
