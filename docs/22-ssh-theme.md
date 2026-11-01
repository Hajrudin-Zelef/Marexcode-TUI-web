# 22 — Thème du panneau SSH (simple)

## Principe

La fenêtre SSH (`/ssh-ui/`) est un **document séparé** (iframe same-origin sur
`neva.example-tailnet.ts.net`). Ses couleurs d'origine sont vertes et écrites en dur.

La page injecte donc `<style id="marex-ssh-theme">` dans `contentDocument` :

- au **chargement** de l'iframe (`sshFrame.addEventListener("load", …)`) ;
- à chaque **changement de thème** (`applyTheme` → `syncSshTheme()`).

Aucune modification du code `/ssh-ui/`.

## Ce qui est repeint

- corps/fond (remplace le dégradé vert) ;
- formulaire et carte de connexion (`.connect-layer`, `.connect-dialog`, en-tête,
  icône, sous-titre) ;
- champs, boutons, `.primary` (dégradé accent → accent2, texte `--on-accent`) ;
- onglets, terminal (`#term`), liste SFTP (lignes, aperçu, chemins) ;
- messages d'état (`.err`, `.warn`, `.ok`), note.

Les couleurs viennent des variables du thème courant (`--accent`, `--accent2`,
`--surface*`, `--fg*`, `--muted`, `--border*`, `--on-accent`, `--danger`, `--warn`)
et de `withAlpha()` pour les teintes.

## Portée

- Fonctionne sur le **fallback Tailscale** uniquement (le panneau SSH n'existe pas
  sur le domaine public ; `/ssh-ui/` y renvoie 404).
- Les deux documents sont sur la **même origine** (`neva.example-tailnet.ts.net`), donc
  `contentDocument` est accessible.

## Tester

- Depuis un navigateur sur le tailnet : choisir Peps/Next/Green, ouvrir SSH →
  la fenêtre doit reprendre la palette.
- Sur le serveur, impossible d'atteindre ts.net depuis 102 (pas de tailscaled) ;
  la validation a été faite avec un harness Playwright qui sert l'iframe réelle
  et injecte le thème (marex/peps/next) : fonds et boutons conformes, 0 erreur.

## Retour arrière

Retirer la fonction `syncSshTheme()`, son hook `load` et l'appel dans `applyTheme`,
puis redéployer la page (+ `marexcode-web-deploy`).

Sauvegarde avant modification : `/root/marexfile-backup/105-ssh-pre-*.tgz`.
