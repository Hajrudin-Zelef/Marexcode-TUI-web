# 18 — Thèmes de l'interface

L'interface propose **6 thèmes** choisis dans **Réglages → Apparence** (engrenage
dans le header, ou menu **⋯** sur mobile).

## Les thèmes

| id (`data-theme`) | Nom affiché | Palette |
|---|---|---|
| `marex` (défaut) | Marexcode | noir profond, vert menthe (`#a6e3b2`) |
| `peps` | Marexcode Peps | noir bleuté, bleu électrique (`#3d7bff`) + rouge néon (`#ff2d55`) |
| `modern` | Marexcode Modern | argent, aubergine (`#b06ad9`) + jaune doré (`#f2c14e`) |
| `next` | Marexcode Next Level | noir, jaune éclatant (`#ffe600`) + violet (`#8b5cf6`) |
| `futuriste` | Marexcode Futuriste | marron, argent, violet lavande (`#b9a7ff`) + cuivre (`#c08552`) |
| `green` | Marexcode Green | noir profond, vert émeraude (`#10b981`) + vert acide (`#a3ff12`) |

## Fonctionnement

- Les couleurs sont des **variables CSS sémantiques** définies dans `index.html` :
  `--bg`, `--bg2`, `--panel`, `--surface`, `--surface2`, `--surface3`,
  `--border`, `--border2`, `--fg`, `--fg2`, `--muted`, `--muted2`,
  `--accent`, `--accent2`, `--accent-dim`, `--accent-glow`, `--on-accent`,
  `--danger`, `--warn`.
- Chaque thème est un bloc `html[data-theme="<id>"]{ ... }`. Le défaut est `:root`.
- Les teintes dérivées (bordures, hover, halo) utilisent `color-mix()`.
- `applyTheme(id)` : pose `data-theme` sur `<html>`, écrit `localStorage["marex.theme"]`,
  met à jour `meta[theme-color]`, ré-applique Monaco, MarexFile et le panneau SSH.
- **Anti-flash** : un petit script inline en `<head>` lit `localStorage` et pose
  `data-theme` **avant** le premier rendu (haché dans la CSP).
- Sélecteur : panneau `#settings` → section Apparence (`#themeList`).

## Ce qui suit le thème

- la page (header, panneaux, modales, gate, barre de monitoring) ;
- **Monaco** (thème `marex-<id>` recalculé depuis les variables, voir `19-monaco.md`) ;
- **MarexFile** (injection dans l'iframe, voir `07` et `21`) ;
- **le panneau SSH** (injection simple, voir `22-ssh-theme.md`).

## Ajouter / modifier un thème

1. Ajouter un bloc `html[data-theme="<id>"]{ ... }` avec toutes les variables.
2. Ajouter l'entrée dans `THEMES` (JS) : `{ id, name, sw:[3 couleurs] }`.
3. Ajouter l'id dans l'objet `ok` du script inline en `<head>` (sinon non restauré).
4. Déployer et relancer la CSP : `marexcode-web-deploy` (105).
5. Vérifier : page, Monaco, MarexFile, SSH (ts.net), mobile.

## Vérifs rapides

```js
document.documentElement.getAttribute('data-theme')       // id courant
getComputedStyle(document.documentElement).getPropertyValue('--accent')
localStorage.getItem('marex.theme')
```

## Pièges

- `style-src` doit rester `'unsafe-inline'` pour Monaco : ne pas revenir aux hachages
  de styles (voir `03-securite.md`).
- Toute modification de `index.html` invalide le hachage du **script** inline :
  relancer `marexcode-web-deploy`.
- Les fichiers premium d'origine étaient en CRLF : toujours convertir en LF avant
  déploiement (CSP).
