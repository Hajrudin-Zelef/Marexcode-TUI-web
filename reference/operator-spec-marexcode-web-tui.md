# Marexcode Web — page tout-en-un (ttyd + File Browser + Netdata)

Exposition de **Marexcode Web** sur `https://marexcode.example.com` : page d'accueil
(iframe fichiers à gauche, terminal à onglets au centre, **barre de monitoring
d'une ligne** en bas). Auth unique **nginx basic auth** + fail2ban ; les services
restent en loopback sur 102.
Vérifié en production le 2026-10-30.

## Architecture

```
Internet → PVE:443 (stream SNI + PROXY protocol)
         → 105:443 (TLS, auth_basic, limit_req, realip, log partagé)
         → 102:80  (nginx, allow 10.0.0.105 / 10.0.0.1 seulement)
            ├─ marexcode.example.com  /             → page /var/www/marexcode-web
            │                         /terminal/N/ → 127.0.0.1:768N (ttyd → tmux marex-N)
            │                         /browser/    → 127.0.0.1:8082 (File Browser, same-origin)
            │                         /metrics/    → 102 vhost stats → 19999 (API Netdata)
            ├─ fichiers.example.com   /             → 301 vers la page principale (gated)
            └─ stats.example.com      /             → 127.0.0.1:19999 (Netdata, dashboard direct)
```

- **Page** : source hôte `/home/sam/marexcode-web-index.html` → 105
  `/var/www/marexcode-web/index.html` (design **premium** intégré le 2026-10-31).
  Sources SSH : `/home/sam/marexcode-web-ssh-ui/{index.html,app.js}` → 105
  `/var/www/marexcode-web/ssh-ui/`. Vendors Monaco :
  `/home/sam/marexcode-web-vendor/monaco/` → 105 `/var/www/marexcode-web/vendor/monaco/`.
  Iframe : fichiers same-origin `/browser/`
  (le cross-origin `fichiers.example.com` donnait un 401 nginx dans l'iframe).
  Terminaux `/terminal/1/` … `/terminal/4/` (onglets **S1–S4**, chargés à la
  demande) ; `/terminal/` redirige (301) vers `/terminal/1/`.
  **Monitoring** : pas d'iframe Netdata ; une seule ligne (`#monbar`) avec
  petites icônes SVG — CPU %, RAM utilisée/totale (%), disque utilisé/total (%),
  réseau ↓/↑, load1, uptime — alimentée toutes les 3 s par l'API Netdata via
  `/metrics/api/v1/data?chart=…` (même origine, auth de la page ; pause quand
  l'onglet est caché). Les unités Netdata : `system.ram` en MiB,
  `disk_space./` en GiB, `system.net` en **kilobits/s** (affiché Mb/s), `idle`
  absent sur Netdata 2.x (somme des dims = usage).
  **Mobile (≤820px)** : terminal plein écran par défaut, panneau Fichiers en
  overlay ; la barre de monitoring reste visible, sur une ligne défilable.
  **Visionneuse** : un clic sur un fichier dans File Browser ouvre un modal
  (capture du clic dans l'iframe same-origin ; les dossiers naviguent
  normalement). Contenu via l'API File Browser avec le cookie `auth` :
  `/browser/api/raw/<chemin>?inline=true` + `/api/resources` pour la taille.
  Images/PDF/vidéo/audio natifs, texte et code dans un `<pre>` (retour à la
  ligne), binaire > 8 Mo renvoyé vers « Télécharger ». `Échap`, clic hors du
  panneau ou ✕ ferment ; « Ouvrir dans Fichiers » bascule sur la route aperçu.
- **105** : 3 vhosts (`marexcode`, `fichiers`, `stats`), tous avec
  `auth_basic_user_file /etc/nginx/.htpasswd-marexcode`, `limit_req zone=ttyd`
  (**20 r/s, burst 50**), `set_real_ip_from 10.0.0.1; real_ip_header proxy_protocol;`
  et `access_log /var/log/nginx/marexcode.access.log` (log unique pour fail2ban).
  Certs Let's Encrypt séparés (`marexcode`, `fichiers`, `stats`).
- **102** : `conf.d/marexcode.conf` (locations `/terminal/1..4/` → `127.0.0.1:7681..7684`,
  en-têtes communs dans `/etc/nginx/snippets/ttyd-proxy.conf`, passe
  `X-Remote-User $http_x_remote_user`), `conf.d/fichiers.conf`, `conf.d/stats.conf`.
  Tous restreints à 105/host.
- **Terminal = shell complet + tmux** (`ttyd-marexcode@.service`, instances 1–4,
  user `sam`, `WorkingDirectory=/home/sam`) : ttyd `-W -O -i 127.0.0.1 -p 768N
  --base-path /terminal/N`, puis `/usr/local/bin/marex-tmux N` — crée si besoin
  la session `marex-N` (`tmux new-session -d -c /home/sam`), met
  `status off` (pas de barre verte en bas) puis `tmux attach -t marex-N`.
  Chaque onglet = session tmux indépendante qui survit à la déconnexion, au
  rechargement **et au redémarrage du service** ; deux appareils sur le **même**
  onglet partagent la session. L'ancien `ttyd-marexcode.service` (TUI directe,
  port 7681) est désactivé (fichier conservé).
  ttyd ne lance son enfant qu'à la première connexion client : `tmux ls` ne montre
  `marex-N` qu'après ouverture de l'onglet.
- **Workspace** : Marexcode utilise `MAREX_WORKSPACE || process.cwd()` ; on démarre
  dans `/home/sam`, on fait `cd <projet>` puis `marexcode` (wrapper
  `/usr/local/bin/marexcode` → `bun /home/sam/marexcode/dist/marex-tui.js`).
  `/etc/profile.d/10-marexcode.sh` ajoute `~/.bun/bin` et `~/.npm-global/bin` au
  PATH et affiche l'aide « cd <projet> puis marexcode ».
- **File Browser** (`filebrowser-marexcode.service`, user `sam`) :
  `-b /browser -r /home/sam -p 8082 -a 127.0.0.1 --noauth -d /home/sam/.filebrowser.db`
  (v2.63.23, monté sous le même origin que la page).
- **Netdata** : install kickstart stable sans télémétrie, `[web] bind to =
  127.0.0.1:19999` ; sert de **source de métriques** à la barre via `/metrics/`
  (proxy 105 → 102 vhost `stats`). Le dashboard complet reste accessible sur
  `stats.example.com` mais n'est plus affiché dans la page.
- **Fail2ban 105** : jail `nginx-ttyd` sur `/var/log/nginx/marexcode.access.log`
  (filtre `^<HOST> -.*" 401 `), `ignoreip` inclut `203.0.113.10`,
  `10.0.0.0/24`, `10.0.1.0/24` et `192.168.1.0/24` (réseaux internes).
- **Fallback Tailscale** : `tailscale serve --bg --https=8443 http://10.0.0.105:80`
  → `https://neva.example-tailnet.ts.net:8443` ; vhost HTTP `neva.example-tailnet.ts.net` sur 105
  (page + `/terminal/` + auth).

## Opérations

- Changer le mot de passe (saisie masquée, jamais dans le chat), sur PVE :
  `umask 077; while :; do read -rsp 'mdp: ' P; echo; [ -n "$P" ] && break; done`
  puis `printf 'marex:%s\n' "$(printf '%s' "$P" | openssl passwd -apr1 -stdin)" > /tmp/hp`,
  `pct push 105 /tmp/hp /etc/nginx/.htpasswd-marexcode`,
  `pct exec 105 -- sh -c 'chown root:www-data /etc/nginx/.htpasswd-marexcode; chmod 640 /etc/nginx/.htpasswd-marexcode; nginx -t && systemctl reload nginx'`,
  `rm -f /tmp/hp; unset P`.
- Services : `ttyd-marexcode@{1,2,3,4}`, `marexws`, `marexgate`,
  `filebrowser-marexcode`, `netdata` (102) ; `nginx`, `fail2ban` (102 et 105).
- SSH : `marexssh status|known-hosts|forget <hôte:port>|audit [n]` (root, PVE) ;
  logs `/var/lib/marexssh/audit.jsonl` ; service `marexssh.service`.
- Déployer la page : `pct push 105 <source> /var/www/marexcode-web/index.html`
  puis `pct exec 105 -- /usr/local/sbin/marexcode-web-deploy` (CSP + reload).
- Passkeys : ajout/suppression dans le modal « Appareils » (suppression =
  step-up). En base : `webauthn_credentials` (une ligne par passkey/domaine).
- Gate : `marexgate status|devices|revoke <id|all>|ttl <j>|totp-setup|totp-disable|passkeys|passkeys-clear|panic|reset`
  (console 102, `passwd` interactif). Révocation live : `marexws` revalide toutes
  les 10 s ; l’UI Appareils exige un **step-up** maître pour les autres appareils.
- Alertes : `/etc/marexcode/alerts.env` (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`,
  0640 root:marexgate) ; supprimer le fichier = mode silencieux.
- Fail2ban (105) : `nginx-ttyd` (401 Basic, 5/10 min) et `nginx-marexgate`
  (401 de `/gate/login`, 8/10 min) ; `nginx-ttyd` ignore les lignes du gate.
- Sessions tmux : `su - sam -c 'tmux ls'` ; tuer une session la fait recréer à la
  prochaine connexion (`tmux kill-session -t marex-N`) ; ne pas toucher à la session
  historique `marexcode` (opencode).
- Certs : `certbot certonly --webroot -w /var/www/certbot -d <domaine>` sur 105.
- Vérifs : page 200 avec auth / 401 sans ; barre de monitoring (6 segments +
  icônes, `Disque x/y Go`, réseau en Mb/s) ; terminal interactif ;
  `/metrics/api/v1/data?chart=system.cpu…` 200 avec auth / 401 sans ;
  6 mauvais mots de passe → `fail2ban-client status nginx-ttyd` ; 9 échecs maître →
  `fail2ban-client status nginx-marexgate` ; révocation/expiration → WS fermée
  sous ~10 s ; `10.0.0.102:7681|8082|19999|7691-7694|8789` refusés ;
  `ss` sur 102 = loopback.

## Pièges durables

- **105 ne peut pas joindre `127.0.0.1:...` de 102** : tout passe par `10.0.0.102:80`.
- **Rate limit** : ne pas redescendre à 5 r/s — la page charge l'iframe fichiers,
  les WS ttyd et 6 requêtes `/metrics/` toutes les 3 s, ce qui donnait 503/429.
  20 r/s burst 50.
- **Fail2ban** ne voit que `marexcode.access.log` : chaque vhost 105 doit y écrire
  et avoir le `realip` (sinon toutes les IP = 10.0.0.1).
- **PROXY protocol** : le stream PVE envoie PROXY ; tous les `listen 443` de 105
  portent `proxy_protocol`. Ne jamais retirer d'un seul côté.
- **tmux + cgroup ttyd** : le serveur tmux naît dans le cgroup du service ttyd.
  Sans `KillMode=process`, tout `systemctl restart ttyd-marexcode@N` tue aussi
  le serveur tmux et **toutes** les sessions. `KillMode=process` est requis pour
  la persistance ; vérifié (marqueur conservé après restart du service).
- **`-H X-Remote-User`** : header posé par 105 (`$remote_user`) et repassé par 102 ;
  la restriction 105/host sur les vhosts 102 est indispensable (sinon spoof).
- **File Browser** : `--noauth` n'est appliqué qu'à la création de la DB ; projet
  archivé (plus de correctifs) et `/home/sam` exposé (choix assumé, le terminal
  donne déjà un accès shell). Réglages utilisateur indispensables :
  `singleClick=true` (sinon un clic ne fait que sélectionner) et `viewMode=list`
  (sinon grille à grosses icônes). CLI (service arrêté) :
  `filebrowser -d /home/sam/.filebrowser.db users update admin --singleClick --viewMode=list`.
- **Dossiers cachés** : un `location ~ /\.` dans les vhosts renvoyait 403 sur
  `/browser/files/.agents` & co (« You don't have permissions »). Ce bloc a été
  retiré des vhosts marexcode/fichiers ; les dotfolders de `/home/sam` sont
  accessibles.
- **Iframes + Basic auth** : ne jamais mettre un service protégé par `auth_basic`
  dans une iframe **cross-origin** (le navigateur ne renvoie pas les identifiants
  de l'origine parente → page 401 nginx). Les fichiers sont donc servis sous
  `/browser/` (même origine) ; l'API Netdata passe par `/metrics/` (même origine)
  pour la barre, sans iframe.
- **SFTP racine** : « Afficher la racine » n’est possible qu’avec un ticket
  `sftp_root` signé par le gate après step-up ; un ticket normal est refusé.
  Le jeton de session SFTP est secret (mémoire) ; ne pas le journaliser.
- **Revalidation SSH** : `marexssh` interroge `/_gate/verify-neva` (102) toutes
  les 30 s avec le cookie du device ; cette location n’autorise que
  `10.0.0.1`. Ne pas la rendre publique.
- **SSH / Serve** : Serve injecte `Tailscale-User-Login` et **supprime** toute
  valeur envoyée par le client ; le proxy exige en plus un ticket HMAC (un
  utilisateur local ne peut pas usurper l'en-tête sans la clé). Ne pas exposer
  `8791` hors loopback.
- **Clé HMAC SSH** : `/etc/marexcode/proxy.key` (102) et `/etc/marexssh/proxy.key`
  (PVE) doivent rester identiques ; les changer impose de redémarrer
  `marexgate` **et** `marexssh`.
- **known_hosts** : chargé en mémoire au démarrage ; `marexssh forget` redémarre
  le service (coupe les sessions). Clé changée → connexion bloquée avec les
  deux empreintes.
- **Garde-fou tailnet** : **désactivé le 2026-10-31** (règle retirée, timer
  `marex-tailnet-guard.timer` désactivé) → SSH direct tailnet→102:22 rétabli.
  Les unités restent sur disque ; ne pas les réactiver sans raison. Le proxy
  SSH web (`marexssh`) n'en dépend pas.
- **CSP par hachages** : toute modification de la page invalide les hachages ;
  relancer `/usr/local/sbin/marexcode-web-deploy` (105) immédiatement après.
  Symptôme d'oubli : écran de verrouillage figé, JS inline bloqué.
- **Fins de ligne CRLF** : les hachages CSP sont calculées sur le texte brut du
  fichier, alors que le parseur HTML normalise CRLF→LF dans les blocs inline.
  Déployer une page en CRLF casse donc le CSP (tout le JS/CSS inline bloqué).
  **Toujours convertir en LF** (`tr -d '\r'`) avant `pct push`.
- **CSRF/Origin** : les POST du gate exigent l'en-tête `X-CSRF` (sauf
  `/login` et `/webauthn/login/*`) et une `Origin` dans la liste blanche.
  Sans Origin (curl) c'est accepté ; une Origin inconnue → 403.
- **`setTimeout` > 24,8 j** : un délai > `2^31-1` ms est ramené à 1 ms par Node.
  `marexws` fermait donc immédiatement les WS des appareils à TTL > ~24,8 j
  (bug corrigé : plus de timer absolu, l’expiration est vérifiée par la
  revalidation 10 s).
- **Passkeys par origine** : une passkey enregistrée sur `marexcode.example.com`
  n’est pas utilisable sur `neva.example-tailnet.ts.net:8443` (RP ID différent).
  L’UI l’indique ; enregistrer une passkey sur chaque domaine utilisé.
- **ttyd `-H` + 407** : lancé avec `-H X-Remote-User`, ttyd renvoie `407 Proxy
  Auth Required` si l'en-tête manque. 105 le pose depuis `$remote_user` ; un test
  direct sur `10.0.0.102` doit donc envoyer `X-Remote-User: <user>`.
- **Audit WS** : `marexws` écrit `terminal_ws_open`/`terminal_ws_closed`
  (`detail` = device + slot) dans `audit.jsonl` (même user `marexgate`).
- **Alertes Telegram** : token dans `/etc/marexcode/alerts.env` (0640
  root:marexgate, hors dépôt). Supprimer le fichier désactive les alertes.
- **Backup SQLite** : `gate.db` en WAL → une simple copie du `.db` est
  incomplète. Utiliser `VACUUM INTO` (fait : `/root/phase4-gate-backup.db`) ou
  copier `.db`+`-wal`+`-shm` service arrêté.
- **Base File Browser** : ne pas monter sous `/files/` — c'est déjà la route
  interne de File Browser, d'où `/files/files/` ; et une ancienne page HTML en
  cache sans le préfixe d'assets donnait icônes géantes + clics morts. Monter
  sous **`/browser/`** (`-b /browser`) et servir la page/les réponses avec
  `Cache-Control: no-store` (fait dans le vhost 105) pour éviter le HTML périmé.


## Sécurité — phases 1–8 + 3b appliquées (2026-10-31)

- Plan complet sauvegardé dans le dépôt : `/home/sam/marexcode/Plan mode/plan-securite-web.md`
  (sur 102). **Toutes les phases (1–8 + 3b) sont faites ; plan terminé.**
- **Phase 1** : File Browser **lecture seule** (create/rename/modify/delete/execute/share=false,
  download conservé) + **dotfiles masqués/refusés** (`/browser/.../.` → 404) ;
  vhosts 102 limités à `10.0.0.105` + `127.0.0.1` (le `.1`/SNAT tailnet est
  retiré : accès direct tailnet au web bloqué) ; sauvegardes `/root/phase1-backups/`
  (102 et 105).
- **Phase 2** : `marexgate` (`/opt/marexgate`, unité `marexgate.service`, user
  `marexgate`, Node 24 + `@node-rs/argon2` + `node:sqlite`) écoute
  `127.0.0.1:8789` ; DB `gate.db`, audit `audit.jsonl` (0600, `UMask=0077`),
  config `/etc/marexcode/security.json` + `proxy.key` (0640 root:marexgate).
  CLI `/usr/local/bin/marexgate` : `passwd`, `status`, `devices`, `revoke`,
  `ttl`, `totp-setup/disable`, `reset`. Argon2id, TOTP, appareils, TTL 30/90,
  révocation, CSRF, rate limit 10 échecs/10 min, audit. WebAuthn = table +
  routes `501` (phase 3b). **Maître défini par l'utilisateur.**
  CLI lancée en `sam` : le wrapper ré-exécute via `/bin/sudo` (mot de passe
  sudo demandé) puis `/bin/setpriv` ; `/sbin` n’est pas dans le PATH de sam
  (`runuser` introuvable), ne pas revenir à `runuser`.
- **Phase 3a** : maître **imposé**. Page : overlay `#gate` avant chargement,
  login `/gate/login`, TOTP si activé, confiance 30 j (cookie `__Host-marexgate`
  Secure/HttpOnly/SameSite=Strict), bouton Verrouiller (logout → révocation),
  re-check toutes les 60 s. Nginx 102 : `/gate/` proxy, `/_gate/verify` interne,
  `auth_request` sur `/terminal/N/` et `/browser/` (et vhost `fichiers`) ;
  105 proxifie `/gate/` et **redirige `fichiers.example.com` (301) vers la page
  principale** (plus d’accès direct non gaté) ; `/gate/verify` → 404 sur 105.
  IP réelle passée via `X-Real-IP` (audit/rate-limit par
  client, pas par 105). Tests : 401 sans cookie (terminal/browser/WS), 200 avec
  cookie, mauvais mot de passe, TOTP UI, reload sans prompt, verrouillage →
  overlay, audit IP réelle. **Passkey pas encore (3b).** DB gate sauvegardée
  puis restaurée après tests : maître utilisateur préservé, 0 appareil —
  sauvegarde `/root/phase3-gate-backup/` (102).
- **Phase 3b** : **passkeys WebAuthn**. `@simplewebauthn/server` 14.0.3 +
  module `webauthn.js` ; table `webauthn_credentials` migrée (`rp_id`,
  `transports`, `name`, `last_used_at` ; plus de FK bloquante). Endpoints :
  `POST /webauthn/register/options|verify` (device + CSRF),
  `POST /webauthn/login/options|verify` (sans maître), `GET /webauthn/credentials`,
  `POST /webauthn/credentials/<id>/delete` (CSRF + step-up). RP/origine par
  `Host` via `config.webauthn.origins` : `marexcode.example.com` et
  `neva.example-tailnet.ts.net` (`https://…:8443`) ; autre Host refusé. Challenges
  mémoire 3 min à usage unique, compteur d’authentificateur, rate limit
  20 échecs/10 min. UI : bouton « Utiliser une passkey » sur l’écran de
  verrouillage (masqué si aucune) et bloc **Passkeys** dans Appareils
  (ajout, liste par domaine, suppression avec step-up). Un login passkey crée
  le même jeton d’appareil/TTL que le maître ; repli maître toujours possible.
  Tests CDP (authentificateur virtuel) : enregistrement, verrouillage →
  déverrouillage, terminal OK en 30 j, rechargement, suppression.
  **Caveat** : passkeys liées au domaine (une par origine) ; l’origine
  `ts.net` n’est pas testable de bout en bout depuis 102 (102 n’atteint pas le
  listener Serve) — mapping Host validé (`no_passkey` et non `rp_not_allowed`).
- **Phase 5** : **durcissement web**. CSP stricte **par hachages** (aucun
  `unsafe-inline`) : `default-src 'none'`, `script-src`/`style-src` = `'self'` +
  sha256 des blocs inline, `frame-src`/`connect-src` `'self'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
  En-têtes page : XCTO, XFO `DENY`, Referrer-Policy `no-referrer`,
  Permissions-Policy (tout off), COOP/CORP `same-origin`, HSTS, no-store.
  **Déploiement page obligatoire** : après toute édition de
  `/var/www/marexcode-web/index.html`, lancer
  `/usr/local/sbin/marexcode-web-deploy` (105) — il recalcule les hachages CSP,
  teste et recharge nginx. Sans cela, le JS inline est bloqué.
  CSRF : `logout`, `step-up` et toutes les actions authentifiées exigent
  `X-CSRF` ; **Origin** vérifiée sur tous les POST (`403 bad_origin`, audit
  `post_origin_denied`, liste blanche des deux origines). Nginx 105 : zone
  `gate` 5 r/s burst 10 sur `/gate/` (+ `ttyd` 20 r/s) → 429.
  Audit gate logroté (`/etc/logrotate.d/marexgate`). `npm audit` : 0 vuln.
  Tests : 0 violation CSP (terminal, files, aperçu, métriques, Appareils,
  login/step-up/revoke-all), CSRF/Origin 403, rate limit 429 puis retour.
- **Phase 6** : **SSH distant** via Tailscale. Node 24.22.2 dédié dans
  `/opt/marexssh`, user `marexssh`, `ssh2`+`ws`, unité **`marexssh.service`**
  sandboxée sur `127.0.0.1:8791`. `tailscale serve --https=8443 --set-path=/ssh`
  (le `/` reste 105:80). Accès = triple contrôle : `Tailscale-User-Login` =
  `admin@example.com` (injecté par Serve), **ticket HMAC 60 s à usage unique**
  (`POST /gate/ssh/ticket`, device+CSRF, clé `/etc/marexcode/proxy.key` partagée
  avec `/etc/marexssh/proxy.key`), destinations dans `100.64.0.0/10`,
  `10.0.0.0/24`, `192.168.1.0/24` et ports 22/2222. Résolution une fois, toutes
  les IP doivent être autorisées, connexion à l’IP résolue (anti-rebinding), IPv6
  refusé. Clés d’hôte TOFU (`/var/lib/marexssh/known_hosts.json`), mismatch =
  blocage ; CLI `marexssh known-hosts|forget|audit|status` (root, restart le
  service). Pas d’agent/port/X11 ; 3 sessions/appareil, 6/login, idle 15 min,
  max 480 min ; identifiants en mémoire, audit sans secret.
  UI : bouton **SSH** ; public → message + lien tailnet ; `ts.net` → iframe
  `/ssh-ui/` (xterm.js, CSP propre autorisant les styles inline) qui reçoit le
  ticket du parent par `postMessage` (origine + source vérifiées).
  Garde-fou : `iptables -I FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp
  --dport 22 -j DROP` + `marex-tailnet-guard.timer` (120 s). **Désactivé le
  2026-10-31 à la demande de l'utilisateur : accès SSH direct tailnet→102:22
  rétabli ; unités conservées mais `disabled`, règle retirée.**
  Tests : identité absente 403, mauvais ticket, destination/port refusés, mot de
  passe + clé (sortie shell), host key pin/mismatch, chaîne Serve→proxy→SSH,
  UI (public + iframe avec WS simulé), 0 violation CSP.
  **Caveat** : pas de test depuis un vrai navigateur tailnet ; identité validée
  via la requête Serve de l’hôte. **Correctif annexe** : 10.0.0.102 avait été
  banni par la jail `nginx-ttyd` → réseaux internes `10.0.0.0/24`,
  `10.0.1.0/24` et `192.168.1.0/24` ajoutés à `ignoreip` + déban.
- **Phase 7** : **SFTP** sur la même connexion SSH (`sftp` ssh2). Onglet
  « Fichiers » dans l’iframe SSH ; liste/navigation, upload (multi + drag & drop),
  download, renommer, nouveau dossier, dupliquer, aperçu. **Pas de suppression,
  chmod ni éditeur.** Uploads/downloads/aperçus via HTTP sur `marexssh`,
  authentifiés par le **jeton de session** (message `sftp-ready`) ; download par
  **URL à usage unique 60 s**. Écrasement upload : `409` puis confirmation
  (`X-Marex-Overwrite: 1`) ; rename/copie refusent d’écraser. Racine = home ;
  « Afficher la racine » = step-up maître → ticket `sftp_root` (gate vérifie
  `X-Step-Up`) envoyé au proxy sur la WS ; confinement `realpath` (symlinks
  sortants refusés). Limites 2 Go / 2 transferts / aperçu 256 Ko ; aperçu
  toujours `text/plain` + `nosniff` (HTML/SVG jamais rendus), images en blob.
  Révocation en direct : revalidation du cookie device via
  `/_gate/verify-neva` (102, allow 10.0.0.1) toutes les 30 s → session et
  transferts coupés. Tests : liste, navigation, `outside_root` (symlink),
  upload/409/overwrite, aperçu, mkdir/rename/copy + refus d’écrasement,
  download, root refusé/autorisé, home, révocation ~27 s, UI desktop/mobile,
  0 violation CSP.
- **Phase 8** : **validation finale**. Matrice rejouée : page publique 401/200,
  terminal xterm, File Browser, métriques, aperçu, 0 violation CSP ; mobile OK ;
  gate (login/step-up/verrouillage) ; SSH (identité 403, ticket, policy, mot de
  passe + clé, shell) ; SFTP (liste, aperçu, `outside_root`, upload 409/overwrite,
  mkdir/rename/copy, download, racine step-up, home) ; révocation ~27 s SSH /
  ~10 s web. Revue sécurité : ports sensibles 102 en loopback et refusés depuis
  PVE ; `/ssh` non public ; `/ssh-ui/` 404 public / 200 ts.net+CSP ; en-têtes
  complets ; fail2ban (bans externes, ignoreip internes) ; perms 600/640 ;
  systemd 3.7 (gate/ws/ssh) ; `npm audit` 0 (gate + ssh) ; certs 2027-01-28 ;
  logrotate actif. **Garde-fou 102:22 désactivé le 2026-10-31** (accès direct
  rétabli). **Rollback testé** (gate + proxy restaurés puis remis).
  CLI : `passkeys`, `passkeys-clear`, `panic` ; `reset` supprime aussi les
  passkeys. Runbooks complets dans le plan, section 11 (maître, appareils,
  passkeys, panic, clé d’hôte, certs, fail2ban, services, page, audit, backups,
  admin Tailscale, rotation HMAC). Risques résiduels : passkeys par origine,
  `ts.net` non testé de bout en bout depuis 102, revalidation SSH fail-open si
  gate injoignable, root PVE peut lire la clé HMAC, FileBrowser archivé/read-only.
- **sshd 102 conservé** (choix utilisateur : usage admin actif depuis
  `10.0.0.1`). Le garde-fou tailnet→`10.0.0.102:22` a été appliqué en
  phase 6 puis **désactivé le 2026-10-31** à la demande de l'utilisateur
  (accès direct rétabli). Les unités `marex-tailnet-guard` restent présentes,
  désactivées ; le proxy SSH web n'en dépend pas.
- **Phase 4** : révocation/expiration **en direct**. `marexws` (`marexws.service`,
  user `marexgate`, `127.0.0.1:7691–7694` → ttyd `7681–7684`) relaie HTTP/WS,
  valide le cookie au handshake puis **revalide `GET /verify` toutes les 10 s** ;
  révocation/expiration → fermeture WS (1008), tmux conserve la session.
  Nginx `/terminal/N/` pointe vers `769N`, `auth_request` conservé. Gate :
  `POST /step-up` (maître + TOTP → jeton mémoire 5 min) requis pour révoquer un
  **autre** appareil ou tous ; audit `step_up_*`, `revoke_denied_step_up`.
  Page : bouton **Appareils** (liste, IP, activité, expiration, « cet appareil »,
  révoquer / tout révoquer / verrouiller, step-up) ; libellés masqués ≤820 px.
  Alertes **Telegram** (`/etc/marexcode/alerts.env`, 0640 root:marexgate) sur
  nouvel appareil, révocation, trop de tentatives (même chat que fail2ban).
  105 : jail `nginx-marexgate` (POST /gate/login 401, 8/10 min) ; `nginx-ttyd`
  ignore ces lignes. Sauvegarde DB cohérente `/root/phase4-gate-backup.db`
  (les copies `.db` seules sont incomplètes à cause du WAL).
  Tests : WS coupé ~10 s après révocation et après expiration, reconnexion 401,
  step-up mauvais/valide, révocation sans step-up 403, UI desktop/mobile.
- Plan terminé. Maintenance : `npm audit` (gate/ssh), renouvellement certs,
  revue des jails fail2ban, rotation éventuelle de `proxy.key`, mises à jour
  Node/proxy. Runbooks : plan `Plan mode/plan-securite-web.md` section 11.
- Reste détaillé (SSH différé phase 6, SFTP sans suppression, Node 24 dédié sur
  PVE, admin Tailscale, blocage `102:22`) enregistré dans le plan, section 13.
- Décisions inchangées : gate Argon2id + jeton/passkey WebAuthn TTL 30/90 j,
  SSH/SFTP Tailscale admin, proxy PVE loopback, SFTP sans suppression/chmod/édition.

## Design premium (2026-10-31)

- `marexcode-web-premium.tar` (dans `Plan mode/` sur 102) remplaçait uniquement
  le **CSS** de `index.html` (HTML/JS identiques) et le CSS + un modal de
  connexion pour `ssh-ui/` (app.js : classe `embedded` + `connectLayer`).
- Palette : fond `#080b0a`, panneau `#101513`, accent `#a6e3b2`, texte `#e7eee9`.
- Sauvegarde avant déploiement : `/root/premium-backup/web-*.tgz` (105).
- Bundle **v2** (`marexcode-web-tout-en-un-2026-10-31-v2.tar.gz`) : contient le design
  premium, les 6 thèmes, Monaco, le responsive, MarexFile, les optimisations et le
  thème SSH. L'ancien bundle (« complet ») et `marexcode-web-premium.tar` ont été
  supprimés du dossier `Plan mode/`.
- Monaco est fourni dans le bundle (`vendor/monaco/` + sources PVE) : pas de
  reconstruction nécessaire ; sinon voir `19-monaco.md` (Bun + monaco-editor 0.57).


## Monaco (éditeur VS Code) — 2026-10-31

- Volet droit `#monaco`, **toggle** bouton header `#btnMonaco` (à côté de SSH),
  même comportement que Fichiers ; à l'ouverture le terminal `#center` rétrécit.
- **Bundle local** (pas de CDN), construit avec Bun à partir de `monaco-editor`
  0.57 : `monaco.bundle.js` (4,4 Mo, ESM, `self.monaco` + événement
  `marex-monaco-ready`), `monaco.css`, `editor.worker.js`, `json.worker.js`,
  `codicon-*.ttf`. Chargement **paresseux** au premier clic.
- `MonacoEnvironment.getWorker` route `json` vers `json.worker.js`, le reste vers
  `editor.worker.js`. Langages : basic-languages + service JSON (validation).
- Thème `marex` (fond `#090c0a`, accent `#a6e3b2`), minimap, **lecture seule**
  (les fichiers sont read-only par conception ; pas de sauvegarde).
- Ouverture d'un fichier : clic dans File Browser **quand Monaco est ouvert**
  (sinon modal d'aperçu), champ chemin (Entrée), ou bouton « Ouvrir dans Monaco »
  du modal. Limite 3 Mo, binaire détecté (NUL) refusé.
- **Séparateurs** (`#rsplitFiles`, `#rsplitMonaco`) : glisser, flèches ◀ ▶
  (nudge 40 px, sens inversé côté Monaco), double-clic = reset (300/520 px).
  Largeurs persistées (`marex.files.w`, `marex.monaco.w`) + état ouvert
  (`marex.files.open`, `marex.monaco.open`) en localStorage ; clamp au resize.
- **Verrouillage** : `lockUI()` ferme Monaco, détruit le modèle et efface le
  contenu (aucun code sensible laissé derrière le gate).
- CSP mise à jour : `style-src 'self' 'unsafe-inline'` (Monaco injecte des
  `<style>` dynamiques ; les hachages ne peuvent pas les couvrir) et
  `worker-src 'self' blob:`. `script-src` reste strict (hash du script inline +
  `'self'`). Le générateur `/usr/local/sbin/marexcode-csp.py` a été mis à jour ;
  backup `/root/marexcode-csp.py.bak-*`.
- Mobile (≤820 px) : Monaco en overlay plein écran (comme Fichiers), séparateurs
  masqués.


## Responsive mobile (2026-10-31)

- **Viewport** : `viewport-fit=cover`, `--app-h` = hauteur réelle (`visualViewport`
  si présent) et `--hdr-h` = hauteur du header, recalculés sur `resize`,
  `orientationchange`, `visualViewport.resize/scroll`. `body{height:var(--app-h)}`.
- **Header ≤820 px** : logo compact, boutons icône 36×36, safe-area iOS ;
  actions secondaires (Monitoring, Refresh, Appareils, Verrouiller) dans un menu
  **⋯** (`#btnMore` / `.hdr-more`) qui s'ouvre sur une 2ᵉ ligne et se referme
  après une action. Primaire visible : Fichiers, SSH, Monaco.
- **Panneaux** : Fichiers et Monaco en overlay plein écran sous le header
  (`top:var(--hdr-h)`, `height:calc(var(--app-h) - var(--hdr-h))`), largeur
  **inline neutralisée** sur mobile (sinon `width:300px` du splitter persistait).
- **Clavier** : le layout se réduit (ex. 844→420 px), le terminal suit
  (`termwrap` 682→258 px) et les overlays restent au-dessus du clavier.
- **Monitoring** : `#monbar` en grille 3 colonnes × 2 lignes (6 en paysage),
  séparateurs masqués.
- **Onglets** : S1–S4 en `flex:1`, hauteur 36 px (30 en paysage).
- **Paysage** (`max-height:520px` + orientation) : header 44 px, Files borné à
  `min(250px,36vw)`, Monaco `max-width:56vw`, padding réduit.
- Champs (gate, chemin Monaco) en `font-size:16px` sur mobile pour éviter le
  zoom automatique iOS ; safe-areas haut/bas (encoche, barre gestuelle).
- Vérifié Playwright : 390×844, 320×568, 844×390, viewport réduit à 420 px,
  0 débordement horizontal, 0 violation CSP.


## Thèmes de l'interface (2026-10-31)

- **Sélecteur** : bouton palette `#btnTheme` (header desktop, menu ⋯ sur mobile)
  → popover `#themeMenu` listant 6 thèmes avec pastilles de couleurs, coche sur
  l'actif ; fermeture au clic extérieur / Échap / après sélection.
- Persistance `localStorage["marex.theme"]` ; thème appliqué **avant le rendu**
  par un petit script inline en `<head>` (haché par le générateur CSP) → pas de
  flash. `data-theme` sur `<html>`.
- Thèmes (variables CSS `--bg/--panel/--surface*/--border*/--fg*/--muted*/--accent*`) :
  1. **Marexcode** (défaut) — noir profond, vert menthe.
  2. **Marexcode Peps** — noir bleuté, bleu électrique + rouge néon.
  3. **Marexcode Modern** — argent, aubergine, jaune doré.
  4. **Marexcode Next Level** — noir, jaune éclatant + violet.
  5. **Marexcode Futuriste** — marron, argent, violet lavande.
  6. **Marexcode Green** — noir profond, vert émeraude + vert acide.
- Les couleurs sont **sémantiques** (plus de littéraux verts) ; teintes dérivées
  via `color-mix()` pour bordures/hovers/glows.
- **Monaco** suit le thème (thème `marex-<id>` recalculé depuis les variables :
  fond, texte, accent, sélection, scrollbars, minimap).
- **File Browser** (iframe) suit le thème via injection d'un `<style>` dans son
  document (`#marex-fb-theme`) : variables `--background/--surfacePrimary/
  --textPrimary/--blue/--divider/...` + règles `.item`, header, breadcrumbs,
  sélection ; mis à jour à chaque changement et au chargement de l'iframe.
- **Non thémé** : panneau SSH (`/ssh-ui/`) conserve sa palette propre (document
  séparé, CSS littéral) — à raccorder plus tard si souhaité.
- `meta[theme-color]` mis à jour avec `--bg`.


- **Plan d'exécution MarexFile** (SSH thémé simple, branding MarexFile + monogramme MF, optimisations File Browser) : `/home/sam/marexcode/Plan mode/plan-marexfile.md` (sur 102). Phase 0 faite : sauvegardes + baseline.


### MarexFile — branding (2026-10-31)

- File Browser est renommé **MarexFile** : `branding.name=MarexFile`,
  `branding.files=/opt/marexfile-branding`, `branding.disableExternal=true`
  (liens GitHub masqués). Base `.filebrowser.db` conservée (permissions lecture
  seule, `singleClick`, `list`, `hideDotfiles` inchangés).
- Assets : monogramme **MF** (`img/logo.svg`), favicons SVG/ICO et PNG
  180/192/512 sous `img/icons/`.
- `custom.css` (dans le dossier branding) **force l'affichage du monogramme**
  dans l'en-tête/les panneaux étroits : le CSS mobile de File Browser masquait
  le logo à ~300 px.
- Le vhost 105 envoie `Cache-Control: no-store` au niveau serveur et cette
  valeur est héritée par `/browser/` → **aucun cache** des assets File Browser
  (identifié en phase 0, à corriger en phase 3).
- Sauvegardes : `/root/marexfile-backup/pre-branding-*.db`, `post-branding-*.db`,
  `branding-*.tgz` (102).
- Rollback : `config set --branding.files "" --branding.name ""` puis restart.



### Performance File Browser (2026-10-31)

- **Cache** : `Cache-Control` corrigé par locations dédiées (le `no-store` du vhost
  105 était hérité par `/browser/` et annulait tout cache) :
  `assets/` → 1 an `immutable`, `img/` → 1 jour, `custom.css` → `no-cache`.
- **Gate** : `/browser/static/` servi **sans `auth_request`** (JS/CSS/icônes publics) ;
  HTML et API restent gatés. Vérifié : asset 200 sans cookie, API 401.
- **Compression** : `gzip_types` activé sur 102 et sur les deux serveurs 105 ;
  CSS 67 Ko → 22 Ko transférés, listings JSON gzip.
- **Connexions** : `upstream` + `keepalive 16` (105→102 et 102→FileBrowser) sur les
  locations statiques (`Connection ""`).
- **File Browser** : `--disableThumbnails --disableImageResolutionCalc`.
- **Mesure** : Playwright avec `http_credentials` désactive le cache Chromium (artefact) ;
  le gain « rechargement » se vérifie dans l'onglet Réseau (« from disk cache »).
- Sauvegardes : `/root/marexfile-backup/pre-perf-102.conf`, `pre-perf-105.conf`,
  `pre-perf-filebrowser.service`.



### Thème SSH (simple) — 2026-10-31

- `syncSshTheme()` (dans `index.html`) injecte `<style id="marex-ssh-theme">` dans
  l'iframe `/ssh-ui/` : même origine sur ts.net, donc `contentDocument` accessible.
- Repeint : corps, formulaire, carte de connexion, champs, boutons, `.primary`,
  onglets, terminal, liste SFTP/aperçu, messages d'état.
- Appelée au `load` de l'iframe et à chaque `applyTheme()`.
- Couleurs dérivées du thème courant (accent/accent2/on-accent, surfaces, bordures).
- Validé sur harness (marex/peps/next) ; validation finale sur `neva.example-tailnet.ts.net`
  à faire côté utilisateur (non joignable depuis 102).
- Sauvegarde page : `/root/marexfile-backup/105-ssh-pre-*.tgz`.



### Validation finale MarexFile (2026-10-31)

- Desktop + mobile : page/gate/terminal/MarexFile/aperçu/Monaco/6 thèmes OK,
  0 violation CSP, 0 erreur console.
- Sécurité : page 401 sans auth, API 401, statique public 200 (voulu), CSP/HSTS/XFO
  en place, ports 102 en loopback, fail2ban 3 jails.
- **Plan d'exécution MarexFile terminé** (phases 0–4) :
  `/home/sam/marexcode/Plan mode/plan-marexfile.md`.
- Bundle **v2** à jour (MarexFile/thèmes/Monaco/perf/SSH) : voir la section
  « Bundle tout-en-un » plus bas.



### Panneau Réglages (2026-10-31)

- Bouton **engrenage** `#btnSettings` (header desktop, menu ⋯ sur mobile) ; remplace
  l'ancien bouton palette. Le sélecteur de thèmes est dans **Réglages → Apparence**.
- Panneau `#settings` (même style que Appareils/SSH), sommaire vertical desktop /
  horizontal mobile. Sections : Apparence, Monaco, Terminal, Monitoring, Fichiers,
  Sécurité, À propos.
- Préférences **locales** (`localStorage["marex.settings"]`) :
  `monacoFont`, `monacoMinimap`, `monacoWrap`, `monacoTab`, `terminalTab`,
  `monInterval`, `monSegs{cpu,ram,disk,net,load,up}`, `filesOpen`.
- Effets immédiats : thème, options Monaco (`applyMonacoOptions`), intervalle et
  segments du monitoring, onglet terminal (au prochain chargement), panneau Fichiers.
- Sécurité : boutons vers Appareils/Passkeys et Verrouiller ; le maître/TOTP/TTL
  restent en CLI (`marexgate`).
- À propos : état du gate (`/gate/status`), nombre d'appareils (`/gate/devices`),
  thème, version, stockage local, navigateur.
- « Tout réinitialiser » remet les défauts + thème Marexcode + largeurs 300/520.
- Modales **theme-aware** (sheet/en-tête/corps via `--surface*`), slider premium
  (piste et pouce accent), panneau Réglages cohérent avec les 6 thèmes.
- Vérifié Playwright desktop/mobile : ouverture, 6 thèmes, Monaco (16 px, minimap off),
  monitoring (disque masqué, 10 s), onglet S3 après reload, Fichiers masqué,
  Appareils, À propos (11 lignes), reset, 0 CSP/erreur.
- **Bundle v2 antérieur** à ce panneau : régénérer l'archive si besoin.


## Rollback

Restaurer les backups `/root/nginx-backup-tout-en-un-*.tgz` (105 et 102) et
`/root/marex-sessions-backup-*.tgz` (102, unité ttyd + vhost avant tmux) ;
phase 7 : restaurer `/opt/marexssh/server.js`, `/etc/marexssh/config.json`,
`/root/p7-server.js.bak-*` (102) et `/root/marexcode.conf.bak-p7-*` (102),
les fichiers `ssh-ui/index.html` + `app.js`, la page parente et sa CSP ;
`systemctl restart marexssh marexgate nginx`.
phase 6 : `systemctl disable --now marexssh marex-tailnet-guard.timer` ;
`tailscale serve --https=8443 --set-path=/ssh off` ; retirer `/opt/marexssh`,
`/etc/marexssh`, `/var/lib/marexssh`, `/usr/local/sbin/marexssh`, les units
`marexssh`/`marex-tailnet-guard*`, `/usr/local/sbin/marex-tailnet-guard` et la
règle FORWARD ; restaurer `/root/marexcode.conf.bak-p6-*` (105) ; `userdel marexssh`.
phase 5 : restaurer `/root/marexcode.conf.bak-p5-*` et
`/root/ttyd-ratelimit.conf.bak-p5-*` (105), retirer les helpers
`marexcode-web-deploy`/`marexcode-csp.py`, les snippets CSP/en-têtes et
`/etc/logrotate.d/marexgate` ; restaurer `/root/p5-server.js.bak-*` (102).
phase 3b : restaurer `/root/p3b-lib.js.bak-*` et `/root/p3b-server.js.bak-*`
(102), retirer `/opt/marexgate/webauthn.js` et `npm uninstall
@simplewebauthn/server` ; la table migrée reste utilisable (vide).
phase 4 : `systemctl disable --now marexws` puis restaurer
`/root/marexcode.conf.bak-p4-*` (102, `/terminal/N/` → `768N`) ; DB :
`/root/phase4-gate-backup.db` ;
`systemctl disable --now 'ttyd-marexcode@1' 'ttyd-marexcode@2' 'ttyd-marexcode@3' 'ttyd-marexcode@4' filebrowser-marexcode netdata` (102) ;
retirer `fichiers`/`stats` des `sites-enabled` (105) et les certs
(`certbot delete --cert-name …`) ; `tailscale serve --https=8443 off`.

## Bundle tout-en-un v2 (2026-10-31)

- `/home/sam/marexcode/Plan mode/marexcode-web-tout-en-un-2026-10-31-v2.tar.gz`
  (0600, + `.sha256`, sha256 `0a98088eb3fb77c60335cde89a853d6440de1ba396212f87b5a13e837e01cab3`, **217 Mo**) :
  `docs/marex-web/` (00–22, dont thèmes, Monaco, responsive, perf, thème SSH),
  `files/{neva,lxc102,lxc105,backups}` (sources page/ssh-ui/vendor, branding
  MarexFile, snapshot `gate.db`, configs nginx avec cache/gzip, unités, backups),
  `reference/` (plan sécurité, plan MarexFile, specs Operator), `MANIFEST.sha256`
  (8 149 fichiers).
- Contient les secrets (`proxy.key`, `gate.db`, `alerts.env`, `.htpasswd`, certs) :
  à chiffrer avant tout stockage hors-site.
- **Dépendances incluses** : `node_modules` gate/ssh, Node 24 (102/PVE), Bun,
  File Browser, ttyd, Netdata, xterm et Monaco (bundle + workers + codicon).
  Détail : `docs/marex-web/17-dependances.md`.
- Ne remplace pas le `vzdump` (102/105 complets) : complète l'hôte PVE.
  Vérifier avec `sha256sum -c`.
