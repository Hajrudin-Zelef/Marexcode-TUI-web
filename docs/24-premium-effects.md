# 24 — Couche « premium » (animations, flou, profondeur)

Ajoutée le 2026-10-31. Elle ne change **aucune** fonctionnalité : uniquement le rendu
et les micro-interactions. Tout est thémé via les variables `--accent`, `--surface*`.

## Tokens

| Variable | Valeur | Usage |
|---|---|---|
| `--ease-spring` | `cubic-bezier(.16,1,.3,1)` | entrées, feuilles de modale |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | hovers, transitions courtes |
| `--dur-1/2/3` | `.16s / .26s / .46s` | durées standard |
| `--shadow-1/2` | ombres douces | profondeur |
| `--sheen` | dégradé accent | reflet des boutons |

## Effets par niveau

- **Ambiance** : aurore animée (`body::after`, 38 s) teintée accent/accent2 + grain SVG
  (2 %, `mix-blend-mode:overlay`, `body::before`). Désactivés sur mobile et en
  `prefers-reduced-motion`.
- **Verre (≥821 px)** : header 80 % translucide, panneaux translucides avec
  `backdrop-filter: blur(18px) saturate(1.08)`, halo teinté + filet lumineux en haut.
- **Header** : ligne d'accent dégradée, point du logo pulsé, logo qui s'écarte au survol.
- **Boutons** : reflet balayant (`::after` + `--sheen`), ripple au `pointerdown`,
  léger relief au survol, enfoncement au clic, rotation du ⋯ / ↻.
- **Onglets** : soulignement animé (scaleX ressort) + fond actif.
- **Monitoring** : balayage lumineux lent (9,5 s) + ombre portée sur les icônes.
- **Panneaux** : entrée en cascade (`marexCard`), halo accentué au survol (desktop),
  liseré lumineux, focus glow du terminal (`#center:focus-within`).
- **Modales** (viewer, appareils, SSH, réglages) : voile flouté + feuille ressort
  (translateY + scale + blur). **Fermeture animée** : classe `.closing` +
  `marexFadeClose()` (180 ms) puis `display:none`.
- **Portail maître / step-up** : bordure dégradée animée, halo, entrée en blur,
  **secousse** sur mauvais mot de passe / TOTP (`marexShake`).
- **Listes** : items Appareils/passkeys en cascade (délais `nth-child`), puce
  « cet appareil » pulsée, hover sur `.setrow2`.
- **Thèmes** : `html.theming` (480 ms) fait fondre couleurs/bordes/ombres ; toast
  « Thème · <nom> » en bas.
- **Iframes** : FileBrowser et SSH reçoivent transitions/hover/animation d'entrée via
  leurs styles injectés (`syncFileBrowserTheme`, `syncSshTheme`).

## Accessibilité

`@media(prefers-reduced-motion: reduce)` neutralise animations et transitions, et
supprime l'aurore et le grain. Sur mobile, aurore et grain sont coupés, le balayage
monitoring et les reflets désactivés pour préserver la fluidité.

## Pièges

- **Monaco** : le thème doit être `"marex-" + currentTheme()` ; la valeur `"marex"`
  retombait sur le thème clair `vs` (zone blanche). `#monacoBody` et `.monaco-editor`
  sont aussi forcés sur `--surface3` en CSS.
- **CSP** : toute modification de la page change les hachages → relancer
  `marexcode-web-deploy` (sinon JS/CSS inline bloqués).
- **Fermeture** : les animations `both` figent `opacity`; la règle `.closing`
  passe en `animation:none!important` pour laisser la transition de sortie opérer.
- **Performance** : `backdrop-filter` et aurore sont limités au desktop ; sur mobile
  les panneaux restent opaques.
