# Plan d'exécution — MarexFile (SSH thémé, branding, performance)

- **Statut** : ✅ **terminé** — phases 0 à 4 exécutées et validées le 2026-10-31.
- **Date** : 2026-10-31
- **Décisions validées** : logo **monogramme MF** ; miniatures désactivées (reco) ; coupure de 2 s du service acceptée ; appareil de test temporaire pour les mesures accepté.
- **Périmètre** : page Marexcode Web (105), File Browser (102), nginx 102/105. Aucun changement de la base ni des permissions File Browser.

---

## 1. État initial mesuré (baseline, 2026-10-31)

Mesures Playwright (Chromium headless, réseau local), gate + basic auth, iframe Fichiers chargée.

| Contexte | Page (DCL) | Page transfert | Fichiers (DCL) | Fichiers transfert | Requêtes fichiers |
|---|---|---|---|---|---|
| Desktop froid 1400×900 | 96 ms | 225 Ko | 238 ms | 671 Ko | 13 |
| Desktop chaud | 42 ms | 225 Ko | 101 ms | 671 Ko | 13 |
| Mobile froid 390×844 | 86 ms | 225 Ko | 228 ms | 499 Ko | 9 |
| Mobile chaud | 38 ms | 225 Ko | 121 ms | 499 Ko | 9 |

- Listing API `/browser/api/resources/marexcode` : **6–7 ms**, 4 418 octets, **sans compression** (`content-encoding: null`).
- Poids principaux de l’iframe : `index-BqkXVoMb.js` 223 Ko (déjà gzip), `i18n` 191 Ko, `index-BOEsmRAc.css` **67 Ko non compressé**, `dayjs` 15 Ko.
- **Constat clé** : le vhost 105 envoie `Cache-Control: no-store` au niveau serveur ; cette valeur est héritée par `/browser/` et **annule le cache** de File Browser. D’où des rechargements qui retéléchargent ~670 Ko à chaque fois (le « chaud » ne gagne presque rien).

---

## 2. Phase 1 — MarexFile (nom + logo) — 30 min

### Fichiers
- Dossier `/opt/marexfile-branding/` (755 root:root, fichiers 644) :
  - `img/logo.svg` — monogramme **MF**, carré arrondi, couleurs neutres/lisibles sur les 6 thèmes.
  - `img/icons/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`.
  - `custom.css` — uniquement si besoin de masquer des résidus (crédits/liens).
- PNG générés avec **PIL** (`/home/sam/venv-cetas`), SVG écrit à la main (pas d’ImageMagick/rsvg sur 102).

### Activation (arrêt ~2 s, base BoltDB verrouillée)
```sh
systemctl stop filebrowser-marexcode
/usr/local/bin/filebrowser -d /home/sam/.filebrowser.db config set \
  --branding.name "MarexFile" \
  --branding.files /opt/marexfile-branding \
  --branding.disableExternal
systemctl start filebrowser-marexcode
```
- **Ne pas** recréer `.filebrowser.db` (lecture seule, `singleClick`, `viewMode=list`, `hideDotfiles` conservés).
- Vérifier après : `filebrowser … users ls` (permissions inchangées), titre d’onglet/manifeste « MarexFile », logo/favicon, absence des liens GitHub.

### Retour arrière
```sh
systemctl stop filebrowser-marexcode
filebrowser -d /home/sam/.filebrowser.db config set --branding.files "" --branding.name ""
systemctl start filebrowser-marexcode
```

---

## 3. Phase 2 — SSH assorti au thème (simple) — 30 min

- Aucune modification du code `/ssh-ui/` : la page parente injecte `<style id="marex-ssh-theme">` dans l’iframe (même origine sur `neva.example-tailnet.ts.net`).
- Injection refaite au chargement de l’iframe et à chaque changement de thème (même mécanisme que File Browser).
- Couleurs transmises : fond, panneaux, texte, bordures, accent, accent secondaire, texte sur accent.
- Éléments repeints uniquement : corps, titre, carte de connexion, champs, boutons/`.primary`, onglets, `#term`, liste SFTP (lignes/entête/aperçu), messages d’état, note.
- Tests : rendu validé sur banc local (route Playwright) + validation utilisateur sur `neva.example-tailnet.ts.net`.
- Retour arrière : suppression de la fonction d’injection (page uniquement).

---

## 4. Phase 3 — Rapidité File Browser (gains ciblés) — 45 min

### 4.1 Correction du cache (le plus gros gain)
Le vhost 105 met `Cache-Control: no-store` au niveau `server`. Ajouter des locations spécifiques qui **redéfinissent** l’en-tête (les `add_header` d’un niveau enfant remplacent l’héritage) :

- Sur **105** (vhost marexcode) :
  - `location ^~ /browser/static/assets/` → proxy vers 102 + `add_header Cache-Control "public, max-age=31536000, immutable" always;`
  - `location ^~ /browser/static/img/` → `max-age=604800`
- Sur **102** :
  - même découpage, avec **suppression de `auth_request`** pour `/browser/static/` (JS/CSS/icônes non sensibles) ;
  - `proxy_buffering on` pour ces fichiers (le reste de `/browser/` reste gaté, non bufferisé).

### 4.2 Compression
- 105 et 102 : `gzip on; gzip_vary on; gzip_proxied any;`
  `gzip_types text/plain text/css application/json application/javascript image/svg+xml;`
- Effet : CSS 67 → ~12 Ko, JSON des listings compressé.

### 4.3 Connexions internes
- `upstream` + `keepalive 16` pour 102 → 127.0.0.1:8082 et 105 → 102, avec `Connection ""` **uniquement** sur les locations statiques (ne pas casser les upgrades).

### 4.4 File Browser
- Relancer avec `--disableThumbnails --disableImageResolutionCalc` (déjà décidé).
- `--disableTypeDetectionByHeader` seulement si les mesures le justifient.

### 4.5 Mesures après
- Mêmes scénarios Playwright (froid/chaud, desktop/mobile), mêmes indicateurs.
- Attendu : **fichiers en cache au 2ᵉ chargement (0 Ko), CSS ~-80 %**, JSON compressé, moins de requêtes gate.

### Retour arrière
- Restaurer `/root/marexfile-backup/105-*.tgz` et `102-*.tgz`, `nginx -t && systemctl reload nginx`, retirer les flags, restart File Browser.

---

## 5. Phase 4 — Validation et documentation — 20 min

- Matrice fonctionnelle : page, gate, 4 terminaux, Fichiers (MarexFile), aperçus, Monaco, SSH (thème), mobile 390 px.
- Sécurité : gate toujours actif sur HTML/API ; statique non sensible ; CSP ; fail2ban ; 401 sans auth.
- Tableau avant/après consigné ici.
- Mise à jour du brain Operator (spec) + catalogue.

---

## 6. Hors périmètre (décision ultérieure)

- Panneau **MarexFile natif** (suppression de l’iframe) : vrai « instantané », retire une dépendance archivée.
- Thème **complet** du panneau SSH.
- Sauvegarde hors-site (MEGA/rclone).

---

## 7. Journal

### 2026-10-31 — Phase 0
- Sauvegardes :
  - 105 : `/root/marexfile-backup/105-1793472383.tgz` (page, vhost, snippets, scripts, htpasswd)
  - 102 : `/root/marexfile-backup/102-1793472384.tgz` (`.filebrowser.db`, unit, vhost marexcode, `/etc/marexcode`)
- Baseline mesurée (tableau section 1). Cause principale identifiée : `no-store` hérité sur `/browser/`.
- Appareil de test temporaire créé puis supprimé ; utilisateur `qa` retiré du htpasswd.

### 2026-10-31 — Phase 1 (MarexFile) ✅

- Généré `/opt/marexfile-branding/` : `img/logo.svg` (monogramme MF), `img/icons/favicon.svg`,
  `favicon.ico`, `apple-touch-icon.png` (180), `android-chrome-192/512`.
- `custom.css` : force le monogramme visible dans l'en-tête même en panneau étroit
  (l'iframe fait ~300 px, le CSS mobile de File Browser masquait le logo).
- Config appliquée (service arrêté ~2 s) :
  `--branding.name "MarexFile" --branding.files /opt/marexfile-branding --branding.disableExternal`.
- Vérifié : `window.FileBrowser.Name=MarexFile`, `DisableExternal=true`, logo/favicons servis
  depuis le dossier branding, **0 lien GitHub**, titre d'onglet « … - MarexFile ».
- Permissions DB inchangées (lecture seule, `singleClick`, `viewMode=list`, `hideDotfiles`).
- Sauvegardes : `pre-branding-*.db`, `post-branding-*.db`, `branding-*.tgz` dans `/root/marexfile-backup/`.
- Les miniatures restent actives (désactivation prévue en phase 3).

### 2026-10-31 — Phase 3 (performance) ✅

**Nginx 102** (`/etc/nginx/conf.d/marexcode.conf`, backup `pre-perf-102.conf`)
- `upstream marexfb` + keepalive 16 (vers 127.0.0.1:8082).
- `gzip on/vary/proxied` + types (CSS/JSON/JS/SVG).
- Locations statiques **sans `auth_request`** : `custom.css` (no-cache), `assets/`
  (1 an immutable), `img/` (1 jour), `static/` (1 h), buffering on, `proxy_hide_header Cache-Control`.

**Nginx 105** (`sites-available/marexcode.conf`, backup `pre-perf-105.conf`)
- `upstream marexweb` + keepalive 16 (vers 102).
- gzip sur les 2 serveurs ; locations statiques identiques (HTTP ts.net + HTTPS),
  `auth_basic off` pour les assets (publics), `proxy_hide_header Vary/Cache-Control/XCTO`.

**File Browser** (unit, backup `pre-perf-filebrowser.service`)
- `--disableThumbnails --disableImageResolutionCalc`.
- Config/branding et permissions inchangés.

**Mesures après (headless, avec auth émulée)**
| Contexte | Page | Fichiers |
|---|---|---|
| Desktop froid | 92 ms · 225 Ko | 237 ms · **636 Ko** (vs 671) |
| Mobile froid | 75 ms · 225 Ko | 239 ms · **459 Ko** (vs 499) |
| Listing API | — | **gzip** (était non compressé) |

- CSS : 66 934 → **22 174 o** transférés (gzip).
- Assets statiques : **200 sans cookie** (gate évité) ; API toujours gatée (401 sans cookie).
- `Cache-Control: public, max-age=31536000, immutable` vérifié sur les assets.

**Limite de mesure** : Playwright avec `http_credentials` (auth Basic émulée) **désactive
le cache HTTP** de Chromium (vérifié : avec credentials le 2ᵉ chargement n'est jamais
« from disk cache », sans credentials il l'est). Les gains de cache (rechargements)
sont donc réels en navigateur mais **non mesurables ici** : à vérifier dans l'onglet
Réseau (colonne « from disk cache »).

**Smoke test** : gate fermé, terminal, liste Fichiers (34 entrées), aperçu README,
Monaco JSON 67 lignes, 0 erreur console.

### 2026-10-31 — Phase 2 (thème SSH simple) ✅

- Ajout dans `index.html` : `syncSshTheme()` injecte `<style id="marex-ssh-theme">`
  dans l'iframe `/ssh-ui/` (même origine sur ts.net), aux couleurs du thème courant.
- Hook : appelée au chargement de l'iframe (`load`) et à chaque `applyTheme()`.
- Repeint uniquement : fond/corps, formulaire, carte de connexion, champs, boutons,
  `.primary`, onglets, terminal, liste SFTP (lignes/aperçu), messages d'état, note.
- Test (harness Playwright avec l'iframe réelle servie par route) :
  - marex : fond `rgb(9,12,10)`, bouton dégradé menthe, champs sombres ;
  - peps : fond `rgb(5,7,13)`, bouton bleu→rouge ;
  - next : fond `rgb(5,5,7)`, bouton jaune→violet ;
  - 0 erreur console.
- Non testable depuis 102 : le vrai `neva.example-tailnet.ts.net` (tailnet non routé) —
  à confirmer visuellement par l'utilisateur.
- Sauvegarde page : `/root/marexfile-backup/105-ssh-pre-*.tgz` (105).

### 2026-10-31 — Phase 4 (validation finale) ✅

**Fonctionnel (Playwright, desktop 1400×900 + mobile 390×844)**
- Page 200 avec auth, **401 sans auth** ; gate fermé, terminal actif, monitoring OK.
- Fichiers : titre « … - MarexFile », logo MF servi, 34 entrées, **0 lien GitHub**,
  surface `#0c100e`.
- Aperçu README, Monaco JSON (67 lignes, fond thème), 6 thèmes listés.
- Thème Peps : `--accent #3d7bff`, File Browser recoloré (`--surfacePrimary #080a12`).
- Mobile : header 52 px, menu ⋯, monitoring 3 colonnes, **aucun débordement** ;
  sélecteur de thèmes plein écran (6 entrées, tient dans l'écran) ; Green appliqué.
- **0 violation CSP, 0 erreur console** sur desktop et mobile.

**Sécurité / réseau**
- Page : CSP stricte (2 hachages de script), HSTS, XFO DENY, nosniff, Referrer,
  Permissions, COOP/CORP, `no-store`.
- Statique : `200` sans auth (public, voulu) ; **API `401` sans auth**.
- Services actifs : nginx, marexgate, marexws, filebrowser, netdata, ttyd@1–4 (102) ;
  nginx + fail2ban (105) ; marexssh (PVE) ; garde-fou 102:22 désactivé (choix user).
- Ports 102 : loopback uniquement (7681, 7691, 8082, 8789, 19999).
- Fail2ban : 3 jails, 0 banni au moment du test.

**Restant hors périmètre**
- Panneau MarexFile natif (option future).
- Validation visuelle du thème SSH sur `neva.example-tailnet.ts.net` (côté utilisateur).
- Bundle `marexcode-web-tout-en-un-*` antérieur à MarexFile/thèmes/perf (à régénérer
  si besoin d'une archive à jour).

### 2026-10-31 — Bundle v2 (sauvegarde PC)

- Bundle **v2** généré : `Plan mode/marexcode-web-tout-en-un-2026-10-31-v2.tar.gz`
  (217 Mo, sha256 `0a98088e…e01cab3`), docs 00–22, sources, branding, vendors Monaco,
  snapshot `gate.db`, configs nginx cache/gzip, backups. `MANIFEST.sha256` (8 149 fichiers).
- Ancien bundle « complet » et `marexcode-web-premium.tar` **supprimés** du dossier.
- Vérifié sur 102 : `sha256sum -c` OK.

### 2026-10-31 — Ajout : panneau Réglages (après le bundle v2)

- Bouton **engrenage** (remplace la palette) → panneau `#settings` avec sections
  Apparence / Monaco / Terminal / Monitoring / Fichiers / Sécurité / À propos.
- Préférences locales : `localStorage["marex.settings"]` (police/minimap/wrap/tab
  Monaco, onglet terminal, intervalle et segments monitoring, panneau Fichiers).
- Reset global + reset des largeurs de colonnes.
- Vérifié desktop/mobile (6 thèmes, Monaco 16 px, disk masqué, S3 par défaut après
  reload, Appareils, À propos, reset, 0 erreur).
- **Le bundle v2 (217 Mo) est antérieur à ce panneau** : régénérer l'archive si tu
  veux une sauvegarde incluant Réglages.

### 2026-10-31 — Bundle v3

- `Plan mode/marexcode-web-tout-en-un-2026-10-31-v3.tar.gz` (217 Mo, sha256
  `2cb28299…cb7d34d`) : docs **00–23** (ajout `23-settings.md`), page/sources à jour
  (panneau Réglages, modales theme-aware), branding, vendors, snapshot gate.
- **v2 supprimé** (comme v1 et le premium tar) ; `sha256sum -c` OK.

### 2026-10-31 — Couche « premium » (UI)

- Tokens d'animation, aurore animée + grain, panneaux de verre (≥821 px),
  halo/filet lumineux, reflet + ripple sur les boutons, logo pulsé, onglet souligné,
  balayage monitoring, cascade des panneaux, items Appareils décalés.
- Modales : voile flouté + feuille ressort ; **fermeture animée** (`.closing`,
  `marexFadeClose`, 180 ms) ; filet lumineux d'entête.
- Portail : bordure dégradée animée, halo, **secousse** sur erreur.
- Thèmes : fondu de couleurs (`html.theming`) + toast.
- Monaco : correction du thème (`marex-<thème>` au lieu de `marex` → `vs` clair).
- `prefers-reduced-motion` neutralise tout ; effets allégés sur mobile.
- Tests Playwright : animations présentes, fermeture OK, 6 thèmes + toasts,
  Monaco `vs-dark`, mobile sans débordement, reduced-motion sans aurore, 0 erreur.
- Bundle v4 à régénérer (docs 00–24).

### 2026-10-31 — Barre de touches mobile (terminal)

- Barre une ligne au-dessus du clavier, visible **uniquement après un tap dans le
  terminal** : `⌄` (ranger le clavier), `⌨` (clavier code), Esc, Tab, ⇧Tab, Ctrl
  (sticky), ↑ ↓ ← →.
- Panneau **clavier code** : contrôle (Alt/⇧/⌫/⏎/Espace), raccourcis `^C ^D ^Z ^L ^A
  ^E ^U ^K ^R ^W`, navigation (Home/End/PgUp/PgDn/Del/Ins, flèches), 32 symboles,
  chiffres, lettres a–z (Shift → majuscules), F1–F12.
- Envoi via events synthétiques dans l'iframe ttyd (keydown/keyup + InputEvent
  insertText) ; focus clavier préservé (`preventDefault` sur pointerdown/touchstart).
- `--kb` calculé depuis `visualViewport` ; monitoring masqué pendant l'affichage.
- Tests : `echo mobile-kb-ok` exécuté, `^C`, `↑` historique, `Tab` complète
  `cd /ho`→`/home/`, Esc, disparition au blur, absente sur desktop.
- Bundle v5 à régénérer (doc 25).

### 2026-10-31 — Clavier code en remplacement du clavier natif

- `⌨` masque le clavier natif (blur textarea) et le panneau **prend sa place**
  (ancré en bas, 250 px → 54 vh ; 56 vh sur écran court).
- `body.ck-on` réserve `--ck-h` via `margin-bottom` de `#main` → le terminal rétrécit
  au lieu d'être recouvert ; barre masquée pendant l'ouverture.
- Bouton « ⌨️ Clavier principal » dans l'entête du panneau : ferme, refocalise le
  textarea (clavier natif) et réaffiche la barre ; `Échap` idem.
- Les touches sont envoyées **sans refocaliser** le textarea quand le panneau est
  ouvert (sinon le clavier natif reviendrait) — vérifié `echo …` + Entrée via tmux.
- Hauteur recalculée au resize/rotation ; `min-width:821px and pointer:fine` pour
  masquer uniquement sur desktop (un téléphone en paysage garde la barre).
- Tests : ouverture (bottom=0, main 792→332), retour (activeElement textarea),
  paysage 844×390 (panneau 218, sans débordement), 320×568.

### 2026-10-31 — Correctif clavier code + défilement

- **Touches sans effet** : remplacement des events DOM synthétiques par
  **`window.term.input()`** (API xterm exposée par ttyd dans l'iframe) — fiable sans
  focus. Mapping complet (Esc, Tab, ⇧Tab, Ctrl/Alt/Shift, flèches, Home/End,
  PgUp/PgDn, Del/Ins, F1–F12) + repli synthétique si `term` absent.
- **Clavier qui couvre les champs** : `#codekb` z-index 93 et barre 94, **sous les
  modales** (100) ; la barre ne s'ouvre plus si une modale est ouverte.
- **Défilement impossible** : tmux tourne en écran alterné (pas de scrollback xterm).
  `marex-tmux` active **`mouse on`** (appliqué aussi aux sessions existantes) et le
  glissement tactile envoie des molettes SGR (copy-mode). Groupe « Défilement »
  (⤒ Historique / ⤓ Direct) dans le clavier code.
- Vérifié : séquences espionnées correctes, `term.input` exécute une commande réelle
  (ttyd de test), molette tmux → copy-mode `[55/263]`.

### 2026-10-31 — Correctif combinaisons clavier natif + verrouillage

- **Cause** : en touchant la barre, le focus quittait le textarea de l'iframe ; la frappe
  native n'atteignait plus le terminal (Ctrl+L inopérant) et la barre se masquait au
  focusout (~380 ms).
- **Solution** : input miroir **`#mkInput`** (1×1 px) dans la page, focalisé au tap
  terminal ; toute la frappe (`beforeinput`/`keydown`/`input`) est convertie et envoyée
  via `term.input`. `focusout` de l'iframe ignoré quand `#mkInput` a le focus.
- **Modificateurs** : 1 appui = one-shot ; 2 appuis rapides (<500 ms) **ou appui long
  (≥550 ms)** = verrouillé (bouton plein) ; nouvel appui = off. Retour « Clavier
  principal » refocalise `#mkInput`.
- Vérifié : Ctrl + `l` natif → `\x0c` (one-shot consommé) ; double-tap/hold + `k` →
  `\x0b` et reste verrouillé ; Enter/Backspace natifs ; barre visible après 1 s ;
  panneau 321 px ; 0 erreur.

### 2026-11-01 — Défilement tactile fiable (copy-mode tmux + badge Direct)

- **Cause** : Marexcode (bun) tourne en plein écran et capture la souris ; les molettes
  injectées n'entraient pas en copy-mode. La molette tmux ne suffit pas.
- **Solution** : le glissement tactile entre en **copy-mode** (`Ctrl+B [`) puis envoie
  `\x1b[A`/`\x1b[B` tous ~22 px ; badge **« ⤓ Direct »** au-dessus de la barre pour
  sortir (`q`) ; toute frappe sort du copy-mode avant d'envoyer la touche.
- Boutons `⤒ Historique` / `⤓ Direct` du clavier code alignés sur ce mécanisme.
- Vérifié avec Marexcode au premier plan : geste → `pane_in_mode=1`, badge visible,
  badge → `pane_in_mode=0`.

### 2026-11-01 — Défilement à deux doigts + FAB (revert du hijack)

- Le geste **mono-doigt** n'est plus intercepté (le TUI reste utilisable).
- **Deux doigts** → copy-mode (`\x02[`) + flèches (`\x1b[A`/`\x1b[B`).
- **FAB** vertical à droite : `▲` (plus ancien), `▼` (plus récent), `●` (Direct,
  sort du copy-mode) ; visible avec la barre, masqué quand le clavier code s'ouvre.
- Toute frappe sort du copy-mode avant envoi.
- Vérifié : 1 doigt → `pane_in_mode=0` ; 2 doigts → `1` ; FAB `●` → `0`.
