# 06 — Terminaux web (ttyd + tmux)

## Principe

Chaque onglet **S1–S4** est une **session tmux indépendante** servie par ttyd :

```
page /terminal/N/ (iframe)
  → 105 nginx → 102 nginx (auth_request gate)
  → marexws 127.0.0.1:769N (valide le cookie, revalide 10 s)
  → ttyd 127.0.0.1:768N (base-path /terminal/N)
  → /usr/local/bin/marex-tmux N
      ├─ tmux new-session -d -s marex-N -c /home/sam (si absente)
      ├─ tmux set-option -t marex-N status off
      └─ exec tmux attach -t marex-N
```

- Le shell tourne en **`sam`**, dossier de départ `/home/sam`.
- `tmux` garde la session quand l'onglet se ferme, à la déconnexion, au
  rechargement **et au redémarrage du service** (`KillMode=process`).
- Deux navigateurs sur le même onglet **partagent** la même session.
- ttyd ne lance son enfant qu'à la première connexion : `tmux ls` ne montre
  `marex-N` qu'après ouverture de l'onglet.

## Units et ports

| Unit | Port | Base | Session |
|---|---|---|---|
| `ttyd-marexcode@1.service` | 7681 | `/terminal/1` | `marex-1` |
| `ttyd-marexcode@2.service` | 7682 | `/terminal/2` | `marex-2` |
| `ttyd-marexcode@3.service` | 7683 | `/terminal/3` | `marex-3` |
| `ttyd-marexcode@4.service` | 7684 | `/terminal/4` | `marex-4` |
| `marexws.service` | 7691–7694 | — | proxy WS/HTTP |

L'ancien `ttyd-marexcode.service` (TUI directe) est **désactivé** ; le fichier est conservé.

```ini
# /etc/systemd/system/ttyd-marexcode@.service (extrait)
ExecStart=/bin/sh -c 'exec /usr/local/bin/ttyd -W -O -i 127.0.0.1 -p "$((7680 + %i))" \
  --base-path "/terminal/%i" -H X-Remote-User -t "titleFixed=Session %i" \
  /usr/local/bin/marex-tmux %i'
KillMode=process
Restart=always
```

- `-W` : écriture autorisée (sinon terminal en lecture seule).
- `-O` : vérifie l'en-tête `Origin` (105/102 conservent le Host/Origin correct).
- `-H X-Remote-User` : identité ttyd ; **si l'en-tête manque, ttyd répond 407**
  (105 le pose depuis `$remote_user`).
- `KillMode=process` : un `systemctl restart` ne tue pas le serveur tmux partagé.

## Workspace Marexcode

- Marexcode utilise `MAREX_WORKSPACE || process.cwd()`.
- On démarre dans `/home/sam` ; l'utilisateur fait `cd <projet>` puis `marexcode`.
- `/usr/local/bin/marexcode` :

```sh
#!/bin/sh
exec /home/sam/.bun/bin/bun /home/sam/marexcode/dist/marex-tui.js "$@"
```

- `/etc/profile.d/10-marexcode.sh` ajoute `~/.bun/bin` et `~/.npm-global/bin` au
  PATH et affiche « cd <projet> puis marexcode ».
- La TUI se lance depuis le shell : **c'est voulu** (l'ancienne version lançait
  Marexcode directement et on ne savait plus dans quel workspace on était).

## Opérations

```sh
su - sam -c 'tmux ls'                         # sessions
su - sam -c 'tmux kill-session -t marex-2'    # repart propre (recréée à la connexion)
systemctl restart 'ttyd-marexcode@2'          # ne tue pas tmux (KillMode=process)
systemctl status 'ttyd-marexcode@1' marexws
journalctl -u 'ttyd-marexcode@1' -f
```

- Ne pas toucher à la session historique `marexcode` (opencode) si elle existe.
- Les sessions vivent dans `/tmp/tmux-1000/` (recréées au reboot).
- Après un reboot, les 4 services redémarrent ; les sessions tmux sont perdues
  (pas de persistance disque). C'est attendu.

## Ajouter une 5e session (S5)

1. Créer `ttyd-marexcode@5` : `systemctl enable --now 'ttyd-marexcode@5'` (port 7685,
   base `/terminal/5`, session `marex-5` — le template gère tout).
2. 102 nginx : ajouter `location /terminal/5/ { auth_request /_gate/verify;
   proxy_pass http://127.0.0.1:7695; ... }`.
3. 105 nginx : ajouter `location /terminal/5/` (même modèle que les autres) ;
   `nginx -t && systemctl reload nginx` sur 102 puis 105.
4. Page : ajouter `{ name: "S5", url: "/terminal/5/" }` dans `CONFIG.terminals`
   puis **redéployer la page** (`marexcode-web-deploy` recalcule la CSP).
5. Vérifier : `/terminal/5/` → 200 avec cookie, 401 sans.

## Pièges

- **tmux tué au restart** : `KillMode=process` obligatoire.
- **407 Proxy Auth Required** : `X-Remote-User` absent (test direct sur 102 sans
  l'en-tête ; 105 le pose normalement).
- **Page blanche / terminal absent** : CSP non régénérée après édition de la page.
- **Session partagée** : deux onglets sur S1 = même session (comportement normal).
- **PATH sans bun/npm** : le profil de connexion est chargé par le shell ; si un
  wrapper est lancé sans shell, utiliser les chemins absolus.
