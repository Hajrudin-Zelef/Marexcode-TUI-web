# 20 — Responsive mobile

Objectif : interface utilisable au doigt, sans débordement, avec clavier virtuel.

## Points de rupture

- **≤ 820 px** : mode mobile (header compact, overlays, monitoring en grille).
- **Paysage ≤ 520 px de haut** : chrome réduit (header 44 px, colonnes bornées).
- Desktop : layout à colonnes avec séparateurs.

## Variables de viewport

- `--app-h` = hauteur réelle (`visualViewport.height` si disponible, sinon
  `innerHeight`), `--hdr-h` = hauteur du header.
- Recalcul sur `resize`, `orientationchange`, `visualViewport.resize/scroll`.
- `body { height: var(--app-h) }` → quand le clavier s'ouvre, le terminal rétrécit
  au lieu de passer dessous.
- `viewport-fit=cover` + `env(safe-area-inset-*)` pour l'encoche et la barre gestuelle.

## Header

- Logo compact, boutons **36×36 px**, labels masqués.
- Actions secondaires (Monitoring, ↻, Appareils, Verrouiller) dans le menu **⋯**
  (`#btnMore` / `.hdr-more`), qui s'ouvre sur une 2ᵉ ligne et se referme après action.
- Toujours visibles : Fichiers, SSH, Monaco.

## Panneaux

- Fichiers et Monaco deviennent des **overlays plein écran** sous le header :
  `top: var(--hdr-h)`, `height: calc(var(--app-h) - var(--hdr-h))`.
- La largeur inline des colonnes est neutralisée sur mobile (sinon 300 px persistait).
- Séparateurs masqués.

## Monitoring et onglets

- `#monbar` en **grille 3 colonnes × 2 lignes** (6 colonnes en paysage), séparateurs
  masqués.
- Onglets S1–S4 en `flex:1`, hauteur 36 px (30 en paysage).

## Formulaires

- Champs (gate, chemin Monaco) en `font-size:16px` sur mobile → pas de zoom iOS.
- **Réglages** : plein écran, sommaire horizontal défilant, panes empilés ;
  aucun débordement.

## Vérifier

Playwright : 390×844, 320×568, 844×390, hauteur réduite 420 px (clavier) —
vérifier `document.documentElement.scrollWidth > innerWidth` = **false**, overlays
à la bonne hauteur, menu ⋯ fonctionnel, 0 violation CSP.
