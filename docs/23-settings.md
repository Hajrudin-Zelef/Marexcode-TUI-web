# 23 — Panneau Réglages

Panneau central de configuration de l'interface, ouvert par l'**engrenage**
(`#btnSettings`) dans le header (desktop) ou dans le menu **⋯** (mobile).
Il remplace l'ancien bouton palette : les thèmes sont désormais dans **Apparence**.

## Structure

- `#settings` : même mécanisme que les modales Appareils/SSH (`.open`), feuille
  `#settings .sheet`, sommaire `#setnav` + panes `.setpane`.
- Desktop : sommaire vertical à gauche (190 px). Mobile : sommaire horizontal
  défilant, panneau plein écran.
- Les modales sont **theme-aware** : feuille, en-tête et corps utilisent
  `--surface`, `--surface2`, `--surface3` ; les accents suivent le thème.

## Sections

| Section | Contenu | Effet |
|---|---|---|
| **Apparence** | liste des 6 thèmes (pastilles, coche) | immédiat (page, Monaco, MarexFile, SSH) |
| **Monaco** | police 10–20, minimap, retour à la ligne, tabulation 2/4 | immédiat |
| **Terminal** | onglet par défaut S1–S4 | au prochain chargement |
| **Monitoring** | intervalle 3/5/10/30 s, segments CPU/RAM/Disque/Réseau/Load/Uptime | immédiat |
| **Fichiers** | afficher le panneau au démarrage, réinitialiser les largeurs | immédiat / au reload |
| **Sécurité** | boutons Appareils, Passkeys, Verrouiller | ouvre les modales existantes |
| **À propos** | URL, thème, gate (TOTP, passkeys, confiance), appareils, version, Monaco, stockage, navigateur | lecture seule |

## Stockage

Tout est **local au navigateur** :

```json
// localStorage["marex.settings"]
{
  "monacoFont": 12.5, "monacoMinimap": true, "monacoWrap": false, "monacoTab": 2,
  "terminalTab": 0, "monInterval": 3000,
  "monSegs": { "cpu": true, "ram": true, "disk": true, "net": true, "load": true, "up": true },
  "filesOpen": true
}
```

- Thème : `localStorage["marex.theme"]` (comme avant, script inline en `<head>`).
- Largeurs : `marex.files.w`, `marex.monaco.w` ; ouverture Monaco : `marex.monaco.open`.
- Les réglages sont propres à chaque navigateur/appareil (aucun stockage serveur).

## Boutons globaux

- **Tout réinitialiser** : remet les défauts, thème Marexcode, largeurs 300/520,
  vide les clés d'état.
- **Réinitialiser les largeurs** (section Fichiers) : 300 px / 520 px.

## Sécurité / limites

- Le **mot de passe maître**, le **TOTP** et la **durée de confiance** ne sont pas
  éditables ici : ils restent en CLI sur 102 (`marexgate passwd|totp-setup|ttl`).
  La section Sécurité renvoie vers Appareils/Passkeys et Verrouiller.
- Aucune écriture serveur : pas de risque de casser la DB MarexFile ou le gate.
- Les valeurs sont relues au démarrage ; un JSON corrompu retombe sur les défauts.

## Ajouter un réglage

1. Ajouter la clé dans `SET_DEFAULTS` (JS, après `CONFIG`).
2. Ajouter le contrôle dans la section voulue (markup `#settings`).
3. Lire `SETTINGS.<clé>` au moment de l’application (Monaco, monitoring, onglet…).
4. Brancher `syncSettingsUI()` + un écouteur qui met à jour `SETTINGS`, `saveSettings()`
   et applique l’effet.
5. Déployer la page + `marexcode-web-deploy` (CSP).
