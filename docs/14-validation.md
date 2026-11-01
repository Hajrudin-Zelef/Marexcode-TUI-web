# 14 — Validation et tests

État au **2026-10-31** (phase 8 terminée). Toutes les phases 1–8 + 3b sont appliquées.

## Matrice fonctionnelle

| Domaine | Test | Résultat |
|---|---|---|
| Public | page sans Basic auth | 401 |
| Public | page avec Basic auth | 200 + en-têtes + CSP |
| Public | `/ssh` / `/ssh-ui/` non exposés | 404 (après auth) |
| Portail | login maître + cookie | OK |
| Portail | mauvais mot de passe / TOTP | 401 |
| Portail | rate limit | 429 après 10 échecs |
| Portail | verrouillage / logout | OK (CSRF) |
| Portail | step-up mauvais/valide | 401 / 200 |
| Portail | révocation sans step-up | 403 |
| Appareils | liste, révocation, tout révoquer | OK |
| Passkeys | enregistrement, login, suppression | OK (CDP) |
| Passkeys | après suppression | `login/options` 404 |
| Terminal | xterm + shell interactif | OK |
| Terminal | 4 sessions indépendantes | OK |
| Terminal | persistance tmux après restart | OK |
| Terminal | révocation coupe la WS | ~10 s |
| Fichiers | File Browser `/browser/` | OK |
| Fichiers | lecture seule (create/rename/delete) | bloqué |
| Fichiers | dotfiles | 404 |
| Fichiers | aperçu texte/image | OK |
| Fichiers | CSP | 0 violation |
| Métriques | barre 6 segments + unités | OK |
| SSH | identité absente | 403 |
| SSH | ticket invalide | `bad_ticket` |
| SSH | destination publique / port 80 | refusés |
| SSH | mot de passe + clé | shell OK |
| SSH | clé d'hôte pin + mismatch | OK |
| SSH | chaîne Serve → proxy → SSH | OK |
| SFTP | liste, navigation, aperçu | OK |
| SFTP | symlink sortant | `outside_root` |
| SFTP | upload 409 puis overwrite | OK |
| SFTP | mkdir/rename/copy (+refus écrasement) | OK |
| SFTP | download | OK |
| SFTP | racine sans ticket / avec step-up | refusée / OK |
| SFTP | révocation | ~27 s |
| Mobile | page + iframe, débordement | OK |
| Réseau | ports sensibles 102 depuis PVE | refusés |
| Réseau | garde-fou tailnet 102:22 | désactivé le 2026-10-31 |
| Rollback | gate + proxy restaurés puis remis | santé OK |

## Audit sécurité (2026-10-31)

- **Listeners 102** : ttyd/gate/ws/FileBrowser/Netdata en **loopback** ; refusés
  depuis PVE (`7681`, `7691`, `8082`, `8789`, `19999`).
- **105** : 80/443 ouverts (public, derrière PVE) ; 22 LAN.
- **PVE** : 8791 loopback ; 8443 Tailscale (tailnet) ; 80/443 routeur.
- **En-têtes page** : CSP stricte, XCTO, XFO DENY, Referrer, Permissions-Policy,
  COOP/CORP, HSTS, no-store.
- **CSRF/Origin** : OK (403 sans jeton, 403 Origin inconnue).
- **Fail2ban** : jails `nginx-ttyd` + `nginx-marexgate` + `sshd` ; 2 bans externes ;
  ignoreip internes (`10.0.0.0/24`, `10.0.1.0/24`, `192.168.1.0/24`).
- **Permissions** : `gate.db` 600, audit 600, `proxy.key` 640, `security.json` 640,
  `alerts.env` 640, `known_hosts` 600, `htpasswd` 640.
- **systemd** : `systemd-analyze security` = 3.7 (OK) pour gate, ws, ssh.
- **Dépendances** : `npm audit` = **0 vulnérabilité** (gate + ssh).
- **TLS** : certs valides jusqu'au **2027-01-28** ; HSTS.
- **Logrotate** : audit gate (hebdo, 8, compress).
- **Rollback** : `server.js` gate et proxy restaurés depuis les backups puis remis.

## Commandes de re-test

```sh
# page/headers
curl -sk -o /dev/null -w '%{http_code}\n' https://marexcode.example.com/        # 401
curl -sk -D- -o /dev/null -u marex:... https://marexcode.example.com/ | head
# gate
pct exec 102 -- curl -s http://127.0.0.1:8789/status
# ports sensibles
for p in 7681 7691 8082 8789 19999; do timeout 2 bash -c "echo > /dev/tcp/10.0.0.102/$p" && echo OPEN || echo refused; done
# fail2ban
pct exec 105 -- fail2ban-client status
# SSH
curl -s http://127.0.0.1:8791/health
tailscale serve status
```

## Risques résiduels (assumés)

- Passkeys liées au domaine (public vs ts.net).
- `ts.net` non testé de bout en bout depuis 102 (102 n'atteint pas Serve).
- Revalidation SSH fail-open si le gate est injoignable.
- Root PVE peut lire la clé HMAC.
- File Browser archivé (plus de correctifs) mais en lecture seule.
- `sshd` 102 conservé pour l'admin hôte (tailnet bloqué).
- Basic auth en première couche (pas de MFA propre).
- Pas de sauvegarde hors-site à ce jour.
- `/mnt/backup` à 75 % (33 Go libres) : marge limitée.

## Validation interface (2026-10-31)

| Domaine | Test | Résultat |
|---|---|---|
| Design premium | page, header, cartes, modales | OK, 0 violation CSP |
| Thèmes | 6 entrées, application, persistance | OK |
| Thèmes | Monaco recoloré | OK |
| Thèmes | MarexFile recoloré | OK |
| Thèmes | SSH (harness ts.net) | OK (à confirmer sur ts.net) |
| Monaco | ouverture, JSON, 448/67 lignes | OK |
| Monaco | verrouillage efface le contenu | OK |
| Responsive | 390×844, 320×568, 844×390 | 0 débordement |
| Responsive | clavier simulé 420 px | terminal réduit |
| MarexFile | nom, logo, favicons, 0 lien GitHub | OK |
| MarexFile | lecture seule, dotfiles 404 | OK |
| Perf | CSS 67 → 22 Ko, JSON gzip | OK |
| Perf | assets 200 sans gate, API 401 | OK |
| Sécurité | page 401 sans auth | OK |
| Sécurité | CSP/HSTS/XFO/COOP | OK |
| Réglages | ouverture, 6 thèmes, Monaco 16 px/minimap off | OK |
| Réglages | monitoring (disque masqué, 10 s), onglet S3, fichiers masqué | OK |
| Réglages | Appareils, À propos (11 lignes), reset | OK |
| Réglages | mobile plein écran, 0 débordement | OK |

**Audit final** : services actifs, ports 102 en loopback, fail2ban 3 jails,
0 test residuel (appareils `qa` supprimés).

## Validation couche premium (2026-10-31)

| Test | Résultat |
|---|---|
| Aurore animée + grain présents (desktop) | OK |
| Panneaux de verre + halo/filet lumineux | OK |
| Ripple + reflet sur les boutons | OK (1 ripple créé au clic) |
| Entrée en cascade (panneaux, items Appareils) | OK (`marexCard`, `marexItem`) |
| Modale : feuille ressort (blur+scale) | OK |
| Modale : fermeture animée puis display:none | OK (opacité 0 à 60 ms) |
| Portail : bordure animée + secousse sur erreur | OK |
| Thèmes : fondu + toast | OK (6/6) |
| Monaco : `vs-dark`, fond `#090c0a` | OK |
| Mobile : aurore/grain/balayage désactivés, 0 débordement | OK |
| `prefers-reduced-motion` : animations neutralisées | OK |
| Console : 0 erreur, 0 violation CSP | OK |

## Validation barre de touches mobile (2026-10-31)

| Test | Résultat |
|---|---|
| Barre absente avant tap, présente après tap terminal | OK |
| Barre 390 px sans débordement (⌄ ⌨ Esc Tab ⇧Tab Ctrl ↑ ↓ ← →) | OK |
| Disparition au blur (380 ms) | OK |
| Absente sur desktop (>820 px) | OK |
| `echo mobile-kb-ok` tapé au clavier code puis exécuté | OK (capture tmux) |
| `^C`, `Esc` | OK |
| `↑` rappelle l'historique | OK |
| `Tab` complète `cd /ho` → `/home/` | OK |
| `⌄` masque barre + panneau | OK |
| 0 erreur console | OK |

### Clavier code en remplacement (2026-10-31)

| Test | Résultat |
|---|---|
| `⌨` : panneau ancré bottom=0, `#main` 792→332 px | OK |
| Barre masquée pendant l'ouverture | OK |
| Saisie avec textarea flou (panneau ouvert) → `echo …` exécuté | OK (tmux) |
| « Clavier principal » : panneau fermé, barre visible, textarea refocalisé | OK |
| `Échap` ferme et revient au clavier principal | OK |
| Paysage 844×390 (pointeur grossier) : panneau 218 px, 0 débordement | OK |
| 320×568 : panneau 307 px, 0 débordement | OK |
| Desktop : barre/panneau masqués | OK |

### Correctif clavier code (2026-10-31)

| Test | Résultat |
|---|---|
| Séquences espionnées : `\x1b`, `\x1b[A`, `\x1b[H`, `\x1bOP`, `\x1b[15~`, `\x1b[Z`, `\x1b[1;2A`, `\x03` | OK |
| `term.input()` exécute une commande réelle (ttyd de test + tmux) | OK |
| Molette tmux (mouse on) → copy-mode `[55/263]` | OK |
| Glissement tactile → molettes SGR `\x1b[<64/65;5;5M` | OK |
| Clavier sous les modales (z 93/94 < 100) | OK |
| Retour « Clavier principal » (textarea refocalisé) | OK |

### Ctrl/Alt clavier natif (2026-10-31)

| Test | Résultat |
|---|---|
| Ctrl (barre) + `c` clavier natif → `\x03`, bouton désactivé | OK |
| Ctrl + raccourci `^D` → `\x04` | OK |
| Ctrl + lettre `e` (panneau) → `\x05` | OK |
| 0 erreur console | OK |

### Barre + clavier natif — modificateurs (2026-10-31)

| Test | Résultat |
|---|---|
| 1 appui Ctrl → one-shot (on, non lock) ; natif `c` → `\x03` puis off | OK |
| 2 appuis rapides → verrouillé ; natif `d` → `\x04` et reste verrouillé | OK |
| Appui sur verrouillé → off | OK |
| Verrouillé + lettre panneau `e` → `\x05`, reste verrouillé | OK |
| Panneau compact : 321 px (au lieu de 456) | OK |
| Aucun texte parasite au-dessus du header | OK |

### Input miroir & combinaisons (2026-10-31)

| Test | Résultat |
|---|---|
| Tap terminal → focus `#mkInput`, barre visible après 1 s | OK |
| Ctrl (1 appui) + `l` natif → `\x0c`, one-shot consommé | OK |
| Ctrl (2 appuis <500 ms) + `k` natif → `\x0b`, reste verrouillé | OK |
| Appui long Ctrl → verrouillé | OK |
| Enter / Backspace natifs → `\r` / `\x7f` | OK |
| « Clavier principal » → `#mkInput` refocalisé | OK |
| Panneau 321 px, barre masquée pendant | OK |

### Défilement tactile (2026-11-01)

| Test | Résultat |
|---|---|
| Glissement sur le terminal avec Marexcode (bun) au premier plan → `pane_in_mode=1` | OK |
| Badge « ⤓ Direct » visible au-dessus de la barre | OK |
| Badge → `pane_in_mode=0`, badge masqué | OK |
| Toute frappe sort du copy-mode avant l'envoi | OK (même chemin `exitScroll`) |
| 0 erreur console | OK |

### Défilement deux doigts + FAB (2026-11-01)

| Test | Résultat |
|---|---|
| Glissement 1 doigt → `pane_in_mode=0` (TUI intact) | OK |
| Glissement 2 doigts → `pane_in_mode=1` | OK |
| FAB visible avec la barre, masqué avec le clavier code | OK |
| FAB `●` → `pane_in_mode=0` | OK |
| 0 erreur console | OK |
