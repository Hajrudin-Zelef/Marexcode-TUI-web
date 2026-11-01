# 16 — Historique des phases

Plan : `reference/plan-securite-web.md` (document complet, 472 lignes).

## 2026-10-30

- **Phase 1 — fermeture des contournements** : File Browser en lecture seule
  (+ dotfiles bloqués), vhosts 102 limités à 105/loopback, `sshd` 102 conservé.
- **Phase 2 — socle `marexgate`** : Node 24, Argon2id, `node:sqlite`, CLI,
  sessions/appareils/TTL, audit, rate limit, TOTP. Gate en loopback.
- **Phase 3a — maître imposé** : overlay, cookie `__Host-marexgate`, `auth_request`
  terminal/fichiers, `fichiers.example.com` → 301, IP réelle.
- **Phase 3b — passkeys WebAuthn** : `@simplewebauthn/server`, RP par domaine,
  enrôlement/connexion/suppression, UI, repli maître.

## 2026-10-30/31

- **Phase 4 — révocation live + UI appareils** : `marexws` (revalidation 10 s),
  step-up 5 min, UI Appareils, alertes Telegram, jails fail2ban.
  - Bug corrigé : `marexws` fermait immédiatement les WS pour un TTL > 24,8 j
    (`setTimeout` > `2^31-1` ms) → timer absolu supprimé.
- **Phase 5 — durcissement web** : CSP stricte **par hachages**, en-têtes,
  CSRF/Origin, rate limit `gate`, logrotate, `npm audit` 0.
  - Script `marexcode-web-deploy` (CSP + reload) ; obligatoire après édition.
- **Phase 6 — SSH distant** : `marexssh` sur PVE (Node 24 dédié), Tailscale Serve
  `/ssh`, identité admin, ticket HMAC, politique réseau, host keys TOFU,
  garde-fou iptables 102:22 (**désactivé le 2026-10-31**), UI xterm.
  - Correctif : 10.0.0.102 banni par fail2ban → ignoreip internes.
- **Phase 7 — SFTP** : même connexion SSH, upload/download/preview HTTP,
  jeton de session, racine step-up, confinement symlinks, pas de suppression.
- **Phase 8 — validation** : matrice complète, revue sécurité, runbooks,
  répétition rollback, CLI `passkeys`/`passkeys-clear`/`panic`, `reset` nettoie
  aussi les passkeys.

## Corrections notables (déjà intégrées)

- File Browser monté sous `/files/` → `/browser/` (collision de route interne).
- Iframe cross-origin avec Basic auth → 401 ; fichiers rendus same-origin.
- `location ~ /\.` → 403 sur les dotfiles ; retiré.
- Grille géante / clic mort → `singleClick=true`, `viewMode=list`, no-store.
- Barre tmux verte → `status off` via `marex-tmux`.
- ttyd direct Marexcode (mauvais workspace) → shell + `cd` + `marexcode`.
- CSP cassée après édition → script de déploiement.
- `setTimeout` > 24,8 j (marexws) → timers supprimés.
- fail2ban bannissait l'IP interne 102 → ignoreip.
- `runuser` absent du PATH de sam → wrapper `sudo`+`setpriv`.
- Backup DB WAL incomplet → `VACUUM INTO`.

## Bundle tout-en-un (2026-10-31)

- **v1** : documentation + configs + DB + secrets, sans `node_modules` ni binaires.
- **v2 (complet)** : ajoute `node_modules` (`marexgate`, `marexssh`), Node 24
  (102 et PVE), Bun, File Browser, ttyd, Netdata (binaire, libs, state, unité)
  et les libs xterm. Le tar fait ~130–150 Mo compressé.

## Décisions durables

- Auth : Basic auth + maître Argon2id + TOTP optionnel + passkeys, appareils
  révocables, step-up pour les actions sensibles.
- SSH/SFTP : Tailscale admin uniquement, ticket HMAC, home par défaut, racine
  via step-up, host keys épinglées, pas d'agent/port/X11.
- SFTP : sans suppression/chmod/éditeur (volontaire).
- File Browser : lecture seule.
- Pas de hors-site à ce jour (recommandation ouverte).

## 2026-11-01 — défilement à deux doigts + FAB

- Mono-doigt non intercepté (TUI utilisable) ; **deux doigts** = copy-mode + flèches.
- FAB `▲` / `▼` / `● Direct` à droite du terminal ; toute frappe sort du copy-mode.
- Vérifié `pane_in_mode` : 1 doigt 0, 2 doigts 1, `●` 0.

## 2026-11-01 — défilement tactile fiable

- Le glissement entre en **copy-mode tmux** (`Ctrl+B [`) + flèches : fonctionne même
  quand Marexcode/vim capture la souris.
- Badge **« ⤓ Direct »** pour revenir au direct ; toute frappe sort du copy-mode.
- Vérifié `pane_in_mode` 0→1→0 avec Marexcode au premier plan.

## 2026-10-31 — combinaisons clavier natif (input miroir)

- La frappe native passe par un **input miroir `#mkInput`** dans la page : focus fiable,
  combinaisons (Ctrl+L…) fonctionnelles, barre qui ne disparaît plus au focusout.
- Modificateurs : 1 appui = one-shot ; 2 appuis (<500 ms) ou appui long (≥550 ms) =
  verrouillé ; nouvel appui = off.
- Clavier code compact (190 px → 38 vh).
- Détails : `25-mobile-keyboard.md`.

## 2026-10-31 — barre + clavier natif (modificateurs, taille)

- La barre fonctionne à 100 % avec le clavier natif : Ctrl/Alt/⇧ appliqués via
  `beforeinput`/`keydown`.
- **1 appui = one-shot**, **2 appuis rapides = verrouillé** (bouton plein), nouvel
  appui = off ; le verrouillé reste actif après usage.
- Clavier code réduit (190 px → 38 vh, touches 31 px) ; il ne sert qu'aux touches
  supplémentaires.
- Correctif : suppression d'un préfixe de code injecté avant `<!DOCTYPE html>`.
## 2026-10-31 — Ctrl/Alt avec le clavier natif

- Les modificateurs sont **one-shot** et s'appliquent aussi à la frappe du clavier
  natif (`beforeinput`/`keydown` interceptés) : Ctrl+`c` → `\x03`, etc.
- Vérifié : Ctrl (barre) + c natif, Ctrl + ^D, Ctrl + lettre e.

## 2026-10-31 — correctif clavier code (entrée + défilement)

- Touches envoyées via **`window.term.input()`** (xterm ttyd) au lieu d'événements
  DOM synthétiques : fiables sans focus.
- Panneau/barre **sous les modales** (z-index 93/94) : ne couvrent plus les champs.
- Défilement : **tmux `mouse on`** + glissement tactile converti en molettes SGR
  (copy-mode) ; boutons `⤒ Historique` / `⤓ Direct`.
- Détails : `25-mobile-keyboard.md`.

## 2026-10-31 — clavier code en remplacement du clavier natif

- `⌨` masque le clavier natif et le panneau prend sa place (ancré en bas) ;
  `body.ck-on` réserve la hauteur → le terminal rétrécit.
- Bouton **« Clavier principal »** (icône clavier) dans l'entête du panneau pour
  revenir au clavier natif ; `Échap` idem.
- Touches envoyées sans refocaliser le textarea quand le panneau est ouvert.
- Hauteur recalculée au resize/rotation ; desktop masqué (`min-width:821px and
  pointer:fine`), téléphone en paysage conservé.
- Détails : `25-mobile-keyboard.md`.

## 2026-10-31 — barre de touches mobile

- Barre une ligne au-dessus du clavier, visible uniquement après un tap dans le
  terminal : ⌄ (ranger), ⌨ (clavier code), Esc, Tab, ⇧Tab, Ctrl sticky, flèches.
- Clavier code complet (contrôle, raccourcis ^C…^W, navigation, symboles, chiffres,
  lettres, F1–F12) ; envoi via events synthétiques dans l'iframe ttyd.
- `--kb` via `visualViewport`, monitoring masqué pendant l'affichage.
- Détails : `25-mobile-keyboard.md`.

## 2026-10-31 — couche premium

- Aurore + grain, panneaux de verre, halos, reflets/ripple, logo pulsé, onglet
  souligné, balayage monitoring, cascade des panneaux, modales ressort avec fermeture
  animée, secousse du portail, fondu de thème + toast.
- Correction Monaco : `theme: "marex-" + currentTheme()` (sinon thème clair `vs`).
- `prefers-reduced-motion` et mobile : effets neutralisés/allégés.
- Détails : `24-premium-effects.md`.

## 2026-10-31 — interface premium → MarexFile

- **Design premium** (CSS uniquement) : fond, cartes, header 58 px, modales, gate,
  monitoring.
- **Responsive mobile** : menu ⋯, overlays sous header, `visualViewport`, safe-areas,
  grille monitoring, paysage compact.
- **Monaco** : volet VS Code vendorisé (bundle Bun, workers, thème dynamique),
  séparateurs redimensionnables, ouverture depuis MarexFile/aperçu/chemin.
- **6 thèmes** : Marexcode, Peps, Modern, Next Level, Futuriste, Green.
- **MarexFile** : renommage + monogramme MF + favicons + `custom.css`, liens masqués.
- **Performance** : cache immutable, gzip, gate contourné pour le statique,
  keepalive, miniatures désactivées.
- **Thème SSH** : injection simple dans l'iframe `/ssh-ui/`.
- **Bundle v2** : docs étendues (18–22), sources, branding, vendors, snapshot gate.

## 2026-10-31 — barre de touches mobile

- Barre une ligne au-dessus du clavier, visible uniquement après un tap dans le
  terminal : ⌄ (ranger), ⌨ (clavier code), Esc, Tab, ⇧Tab, Ctrl sticky, flèches.
- Clavier code complet (contrôle, raccourcis ^C…^W, navigation, symboles, chiffres,
  lettres, F1–F12) ; envoi via events synthétiques dans l'iframe ttyd.
- `--kb` via `visualViewport`, monitoring masqué pendant l'affichage.
- Détails : `25-mobile-keyboard.md`.

## 2026-10-31 — couche premium

- Aurore + grain, panneaux de verre, halos, reflets/ripple, logo pulsé, onglet
  souligné, balayage monitoring, cascade des panneaux, modales ressort avec fermeture
  animée, secousse du portail, fondu de thème + toast.
- Correction Monaco : `theme: "marex-" + currentTheme()` (sinon thème clair `vs`).
- `prefers-reduced-motion` et mobile : effets neutralisés/allégés.
- Détails : `24-premium-effects.md`.

## 2026-10-31 — Panneau Réglages

- Engrenage dans le header (menu ⋯ sur mobile), remplace le bouton palette.
- Sections : Apparence, Monaco, Terminal, Monitoring, Fichiers, Sécurité, À propos.
- Préférences locales (`marex.settings`) : police/minimap/wrap/tab Monaco, onglet
  terminal, intervalle/segments monitoring, panneau Fichiers.
- Modales rendues **theme-aware** (`--surface*`) et slider premium.
- Reset global + reset des largeurs.
- **Bundle v3** : docs 00–23, page et sources à jour, snapshot gate.
