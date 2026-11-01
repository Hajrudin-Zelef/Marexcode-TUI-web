# Plan de sécurisation — Marexcode Web

- **Statut** : phases 1–8 + 3b appliquées le 2026-10-31 — plan terminé
- **Date** : 2026-10-30
- **Portée** : `https://marexcode.example.com` et `https://neva.example-tailnet.ts.net:8443`
- **Objectif** : mot de passe maître avant tout terminal/fichier, SSH/SFTP réservés au tailnet avec identité admin, sans dégrader l’usage existant.

> **Suivi — phase 1 (2026-10-30)** : File Browser passé en **lecture seule** (create/rename/modify/delete/execute/share=false, download conservé) + **dotfiles masqués** (listing) et **refusés** (`/browser/.../.` → 404). Vhosts 102 limités à **10.0.0.105 + 127.0.0.1** (le `.1`/SNAT tailnet est retiré). Sauvegardes : `/root/phase1-backups/` sur 102 et 105. **sshd 102 conservé** (choix utilisateur : usage actif depuis `10.0.0.1`) ; le blocage tailnet→`102:22` reste à appliquer (ACL ou garde-fou PVE).

> **Suivi — phase 2 (2026-10-30)** : `marexgate` installé sur 102 — Node 24, `@node-rs/argon2`, `node:sqlite`, utilisateur système `marexgate`, écoute **127.0.0.1:8789**, unité sandboxée (`UMask=0077`, `ProtectSystem=strict`, `NoNewPrivileges`, etc.). CLI `/usr/local/bin/marexgate` : `passwd`, `status`, `devices`, `revoke`, `ttl`, `totp-setup/disable`, `reset`. Fonctions testées : Argon2id, sessions/appareils, TTL, révocation, CSRF, rate limit (10 échecs/10 min → 429), TOTP, audit JSONL sans secret. WebAuthn : table + routes `501` (implémentation phase 3/4). **Maître non configuré** (à définir via `marexgate passwd`). **Aucune modification nginx/page** : gate installé mais non imposé.

> **Suivi — phase 3a (2026-10-30)** : maître **imposé**. Page : overlay avant chargement, login maître (+ TOTP si activé), confiance 30 j (cookie `__Host-marexgate` Secure/HttpOnly/Strict), bouton Verrouiller (logout révoque l’appareil), re-vérification périodique. Nginx 102 : `auth_request` sur `/terminal/N/` et `/browser/` (+ vhost `fichiers`), `/gate/` proxy via 105, IP réelle transmise (`X-Real-IP`) pour audit/rate-limit. `fichiers.example.com` **redirige (301)** vers la page principale (plus d’accès direct non gaté) ; `/gate/verify` renvoie 404 sur 105. Tests : 401 sans cookie sur terminal/browser/WS, 200 avec cookie, mauvais mot de passe, TOTP UI, rechargement sans prompt, verrouillage → overlay, audit avec IP client réelle. **Passkey WebAuthn non encore branchée (3b)**. DB gate sauvegardée puis restaurée : mot de passe maître utilisateur préservé, 0 appareil. Sauvegarde : `/root/phase3-gate-backup/` (102).

> **Suivi — phase 4 (2026-10-31)** : révocation/expiration **en direct**. `marexws` (102, 127.0.0.1:7691–7694) relaie HTTP/WebSocket vers ttyd (7681–7684), valide le cookie au handshake puis **revalide toutes les 10 s** ; une révocation ou une expiration ferme la socket (code 1008) et tmux garde la session. Nginx `/terminal/N/` pointe vers `769N` (l’`auth_request` reste en première couche). Gate : `POST /step-up` (maître + TOTP, jeton 5 min, en mémoire) exigé pour révoquer un autre appareil ou tous ; audit `step_up_*`, `revoke_denied_step_up`. UI : bouton **Appareils** (liste, IP, dernière activité, expiration, cet appareil, révoquer, tout révoquer, step-up, verrouiller) ; libellés masqués en mobile. Alertes Telegram (nouvel appareil, révocation, trop de tentatives) via `/etc/marexcode/alerts.env` (même chat que fail2ban ; test envoyé). Fail2ban 105 : nouvelle jail `nginx-marexgate` (POST /gate/login 401, 8/10 min) et `nginx-ttyd` ignore ces lignes. Tests : WS coupé ~10 s après révocation et après expiration, reconnexion 401, step-up mauvais/valide, révocation sans step-up 403, `revoke-all` avec step-up, UI desktop + mobile, audit. Sauvegarde DB cohérente : `/root/phase4-gate-backup.db`.

> **Suivi — phase 3b (2026-10-31)** : **passkeys WebAuthn** opérationnelles. `@simplewebauthn/server` 14.0.3 dans `/opt/marexgate` ; module `webauthn.js` ; table `webauthn_credentials` migrée (colonnes `rp_id`, `transports`, `name`, `last_used_at`, plus de FK bloquante). Endpoints : `POST /webauthn/register/options|verify` (device + CSRF), `POST /webauthn/login/options|verify` (sans maître), `GET /webauthn/credentials`, `POST /webauthn/credentials/<id>/delete` (CSRF + step-up). RP/origine par Host via `config.webauthn.origins` : `marexcode.example.com` → `https://marexcode.example.com` ; `neva.example-tailnet.ts.net` → `https://neva.example-tailnet.ts.net:8443` ; tout autre Host → refus. Challenges en mémoire (3 min, usage unique), compteur d’authentificateur mis à jour, rate limit 20 échecs/10 min. UI : bouton « Utiliser une passkey » sur l’écran de verrouillage (masqué si aucune passkey), bloc « Passkeys » dans Appareils (liste, domaine, ajout, suppression avec step-up). Un login passkey crée le même jeton d’appareil/TTL que le maître. Tests (authentificateur virtuel CDP) : enregistrement (rp_id correct), verrouillage → déverrouillage passkey, terminal OK, TTL 30 j, rechargement fiable, suppression avec step-up, `login/options` → 404 après suppression ; maître conservé, appareils de test supprimés. **Caveat** : passkeys liées au domaine (deux origines) ; la validation de l’origine `ts.net` n’a pas pu être testée de bout en bout depuis 102 (102 ne joint pas le listener Serve) — mapping Host vérifié. **Correction phase 4** : `marexws` fermait toute WS avec un TTL > ~24,8 j (`setTimeout` > 2^31-1 ms → 1 ms). Le timer absolu a été retiré ; l’expiration est traitée par la revalidation 10 s (revérifié : révocation et expiration coupent bien).

> **Suivi — phase 5 (2026-10-31)** : **durcissement web**. CSP **stricte par hachages** (pas de `unsafe-inline`) : `script-src`/`style-src` = `'self'` + sha256 des blocs inline ; `default-src 'none'`, `frame-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`. En-têtes page : XCTO `nosniff`, XFO `DENY`, Referrer-Policy `no-referrer`, Permissions-Policy (tout désactivé), COOP/CORP `same-origin`, HSTS, Cache-Control `no-store`. Script de déploiement **`/usr/local/sbin/marexcode-web-deploy`** (105) : régénère `/etc/nginx/snippets/marexcode-csp.conf` à partir de la page puis `nginx -t` + reload — **obligatoire après toute modification de la page**, sinon les hachages ne correspondent plus. CSRF systématique : `logout`, `step-up` et toutes les actions authentifiées exigent `X-CSRF` ; contrôle **Origin** sur tous les POST (liste blanche des deux origines, `403 bad_origin`, audit `post_origin_denied`). Nginx 105 : zone `gate` 5 r/s burst 10 sur `/gate/` (en plus de `ttyd` 20 r/s) → 429 au-delà. Audit gate : logrotate hebdo (8, compress, copytruncate) via `/etc/logrotate.d/marexgate`. Dépendances : `npm audit` = 0 vulnérabilité (`@simplewebauthn/server` 14.0.3, `@node-rs/argon2` 2.2.2). Tests : en-têtes présents, **0 violation CSP** (terminal, File Browser, aperçu, barre métriques, Appareils, login, step-up, revoke-all), CSRF sans jeton → 403, Origin `evil.example` → 403, 25 requêtes rapides → 14×429 puis retour à 200, maître préservé. **Incident de test** : le « Tout révoquer » du test a révoqué l’appareil réel de l’utilisateur ; il a été restauré (`revoked_at=NULL`) et l’action tracée (`device_unrevoked_restore`).

> **Suivi — phase 6 (2026-10-31)** : **SSH distant** opérationnel via Tailscale. Node **24.22.2 dédié** dans `/opt/marexssh` (pas de Node système), utilisateur `marexssh`, `ssh2`+`ws` ; service **`marexssh.service`** sandboxé sur `127.0.0.1:8791`. `tailscale serve --set-path=/ssh` ajouté (le `/` reste sur 105). L’accès exige : (1) `Tailscale-User-Login` = admin `admin@example.com` (injecté par Serve, anti-spoof) ; (2) un **ticket HMAC 60 s à usage unique** délivré par le gate (`POST /gate/ssh/ticket`, device + CSRF) signé avec `proxy.key` partagé 102/PVE ; (3) une destination dans `100.64.0.0/10`, `10.0.0.0/24`, `192.168.1.0/24` et un port 22/2222 — résolution DNS unique, toutes les IP doivent être autorisées, connexion à l’IP résolue (anti-rebinding), IPv6 refusé. Clés d’hôte **épinglées TOFU** (`/var/lib/marexssh/known_hosts.json`), changement = blocage avec empreintes, CLI `marexssh known-hosts|forget|audit|status`. Pas d’agent/port/X11 ; limites sessions (3/appareil, 6/login), idle 15 min, max 480 min ; identifiants en mémoire, audit sans secret. UI : bouton **SSH** (header) ; sur le domaine public → message + lien tailnet ; sur `ts.net` → iframe isolée `/ssh-ui/` (xterm.js, CSP propre avec styles inline) qui reçoit le ticket du parent par `postMessage` contrôlé. Prérequis appliqué puis **désactivé le 2026-10-31** (accès direct rétabli) : garde-fou PVE `iptables -I FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp --dport 22 -j DROP` + `marex-tailnet-guard.timer` (règle retirée, timer `disabled`). Tests : identité absente → 403, mauvais ticket, destination publique/port refusés, auth mot de passe **et** clé (sortie shell), clé d’hôte épinglée puis mismatch bloqué, chaîne complète **Serve → proxy → SSH** (WS), UI (message public + logique iframe/xterm avec WS simulé, 0 violation CSP). **Caveat** : pas de test depuis un vrai navigateur tailnet (102 n’atteint pas Serve) ; le chemin identité a été validé via la requête Serve de l’hôte (qui injecte l’identité). **Correctif annexe** : fail2ban avait banni `10.0.0.102` (jail ttyd) → réseaux internes `10.0.0.0/24`, `10.0.1.0/24` et `192.168.1.0/24` ajoutés à `ignoreip` et déban.

> **Suivi — phase 7 (2026-10-31)** : **SFTP** dans la même session SSH. Le proxy `marexssh` crée `sftp` sur la connexion `ssh2` existante ; opérations : liste/navigation, upload (fichier/multi + glisser-déposer), download, renommer, nouveau dossier, dupliquer, aperçu lecture seule. **Pas de suppression, pas de chmod, pas d’éditeur.** Uploads/downloads/aperçus passent par HTTP sur le même proxy, authentifiés par le **jeton de session** (retourné au `sftp-ready`) ; les téléchargements utilisent une **URL à usage unique 60 s**. Écrasement d’upload : `409` puis nouvel envoi avec confirmation (`X-Marex-Overwrite: 1`) ; renommage/copie refusent d’écraser. Confinement : `realpath` + racine = home par défaut ; « Afficher la racine » exige un **step-up maître** → le parent obtient un ticket `sftp_root` du gate (vérif `X-Step-Up`), l’iframe l’envoie au proxy sur la même WS ; tout chemin hors racine (symlink compris) est refusé. Limites : 2 Go, 2 transferts simultanés, aperçu 256 Ko ; aperçu toujours `text/plain` + `nosniff` (jamais HTML/SVG rendu), images via blob. **Révocation en direct** : le proxy revalide le cookie du device via `/_gate/verify-neva` (102, allow 10.0.0.1) toutes les 30 s → session WS et transferts coupés (testé ~27 s). Tests : liste, navigation, évasion symlink (`outside_root`), upload/409/overwrite, aperçu texte, mkdir/rename/copy (+ refus d’écrasement), download, root refusé sans ticket puis autorisé, home, révocation, UI desktop/mobile (0 violation CSP).

> **Suivi — phase 8 (2026-10-31)** : **validation finale**. Matrice rejouée : page publique 401 sans basic auth / 200 avec, terminal xterm, File Browser, barre métriques, aperçu, 0 violation CSP ; mobile sans débordement ; message SSH public ; gate (login/step-up/verrouillage déjà couverts) ; SSH (identité 403, ticket, destinations/ports, mot de passe + clé, sortie shell) ; SFTP (liste, aperçu, `outside_root`, upload 409/overwrite, mkdir/rename/copy, download, racine step-up, home) ; révocation live (~27 s SSH, ~10 s web). Revue sécurité : ports sensibles de 102 en loopback et refusés depuis PVE ; `/ssh` non exposé publiquement ; `/ssh-ui/` 404 public / 200 ts.net avec CSP ; en-têtes page complets ; fail2ban 2 bans externes, ignoreip internes ; permissions 600/640 ; durcissement systemd 3.7 (gate/ws/ssh) ; `npm audit` 0 vuln (gate + ssh) ; certs jusqu’au 2027-01-28 ; logrotate gate actif. **Répétition rollback** : restauration puis réinstallation des `server.js` gate et proxy (santé OK). CLI enrichie : `passkeys`, `passkeys-clear`, `panic` ; `reset` supprime aussi les passkeys. Artefacts de test supprimés ; appareils réels préservés. Runbooks détaillés en section 11. Risques résiduels : passkeys par origine, `ts.net` non testé de bout en bout depuis 102, revalidation SSH fail-open si le gate est injoignable, root PVE = clé HMAC lisible, FileBrowser archivé/read-only, sshd 102 conservé, basic auth en première couche.

> **Correctif — 2026-10-31 (hors périmètre applicatif)** : le **garde-fou tailnet → `10.0.0.102:22`** (règle FORWARD + `marex-tailnet-guard.timer`), ajouté en phase 6 comme prérequis de sécurité, a été **désactivé à la demande de l’utilisateur** : règle retirée, timer `disabled`. L’accès SSH direct depuis le tailnet vers 102 est **rétabli** ; le SSH web (`marexssh`) n’en dépend pas et reste inchangé. Les unités restent sur disque (désactivées). Le bundle contient les fichiers du garde-fou (unités **désactivées**) ; ne pas les activer lors d’une restauration (voir 04 et 12).

---

## 1. Décisions validées

| Sujet | Décision |
|---|---|
| Identité d’appareil | Jeton aléatoire + **passkey WebAuthn** (pas de MAC : non lisible en HTTPS, falsifiable) |
| Durée de confiance | **30 jours** par défaut, **90 jours** maximum, configurable |
| Tailscale | Obligatoire **uniquement pour SSH/SFTP** |
| File Browser | Gated + **lecture seule** + dotfiles bloqués |
| Shell web | Reste `sam` (risque assumé) |
| Proxy SSH/SFTP | Sur **PVE**, loopback, utilisateur dédié sandboxé |
| Clés SSH | **Éphémères** (aucun stockage) ; coffre chiffré plus tard |
| Routes LAN | **Conservées** (seul PVE a Tailscale) avec compensations réseau |
| SFTP | Home distant + option racine protégée ; upload/download/renommer/nouveau dossier/dupliquer/aperçu ; **pas de suppression, pas de chmod, pas d’édition** ; écrasement avec confirmation |

---

## 2. Risques actuels identifiés

| # | Risque | Gravité | Mesure prévue |
|---|---|---|---|
| 1 | File Browser écrit dans `/home/sam` → `authorized_keys`, `.bashrc`, code | Critique | Gate + lecture seule + dotfiles bloqués |
| 2 | sshd actif sur 102 (`*:22`) | Critique | Désactivé (ou loopback) |
| 3 | Routes LAN annoncées au tailnet ; SNAT PVE en `10.0.0.1` | Critique | 102 n’accepte que 105/loopback ; ACL ; sshd fermé |
| 4 | Shell `sam` membre de `sudo` | Élevé | Maître + passkey ; risque assumé |
| 5 | Basic auth unique, sans MFA ni révocation | Élevé | Gate maître + appareils + WebAuthn |
| 6 | Pas de CSP/XFO/CSRF | Élevé | En-têtes stricts, JS/CSS externalisés, CSRF |
| 7 | Sessions terminal sans expiration | Moyen | Proxy WS gate-aware |
| 8 | Secrets dans `/home/sam` lisibles | Élevé | Gate + dotfiles bloqués |
| 9 | SSH web (SSRF/MITM/identifiants) | Élevé | Politique réseau, clés d’hôte, mémoire seule |

---

## 3. Architecture cible

```
PUBLIC / LAN
marexcode.example.com:443
  → PVE (stream SNI + PROXY protocol)
  → 105:443 (TLS, basic auth, realip, rate-limit, headers)
      /            page statique (js/css locaux)
      /terminal/N/ → 102:80 → auth_request gate → marexws → ttyd:768N → tmux marex-N
      /browser/    → 102:80 → auth_request gate → FileBrowser:8082 (lecture seule)
      /gate/*      → 102:80 → marexgate:8789
      /metrics/*   → 102 stats → Netdata:19999
      /ssh/*       → 404 (Tailscale uniquement)

TAILNET
https://neva.example-tailnet.ts.net:8443 (Tailscale Serve, identité)
      /            → 105:80 (même application, origine ts.net)
      /ssh/*       → PVE 127.0.0.1:8791 (marexssh, SSH + SFTP)
                     Tailscale-User-Login obligatoire ∈ admin
                     cookie maître validé par marexgate
```

---

## 4. Composants

### 4.1 `marexgate` (102)

- Node 24, utilisateur système `marexgate`, `StateDirectory=/var/lib/marexgate`.
- Écoute `127.0.0.1:8789` et `10.0.0.102:8790` (réservé à PVE, HMAC).
- Argon2id (m=64 MiB, t=3, p=1), TOTP optionnel, WebAuthn, sessions opaques 256 bits hachées.
- Cookie `__Host-marexgate` : `HttpOnly`, `Secure`, `SameSite=Strict`.
- Appareils : nom, création, dernière IP/UA, confiance jusqu’à, révocation ; step-up maître pour révoquer.
- CSRF par session + contrôle `Origin`.
- Rate limit + backoff + jail fail2ban ; audit JSONL ; alertes Telegram.
- CLI locale : `passwd`, `ttl`, `device list/revoke`, `panic`, `recover`.
- Endpoints : `/status`, `/login`, `/logout`, `/step-up`, `/webauthn/*`, `/devices`, `/verify`, `/verify-proxy` (HMAC PVE).

### 4.2 Terminal (S1–S4)

- La page interroge `/gate/status` avant de créer les iframes ; sinon overlay maître.
- `auth_request` sur `/terminal/N/` (HTTP + handshake WS) : contournement impossible.
- Appareil de confiance : aucun prompt pendant 30 j ; passkey possible.
- **`marexws`** (proxy WS gate-aware, 102 loopback) : valide la session, suit les sockets, ferme à l’expiration/révocation ; tmux conserve les sessions.
- Révocation : fermeture immédiate des WS ; reconnexion impossible sans maître.
- Shell toujours `sam` : le maître reste le seul rempart ; le sudo demande encore le mot de passe système.

### 4.3 File Browser (local)

- Même gate ; permissions serveur : `create/rename/modify/delete/execute/share = false`, `download = true`.
- Dotfiles refusés (`/.ssh`, `.env`, `.config`…).
- Racine `/home/sam` conservée mais **lecture seule** : plus d’injection `authorized_keys` ni de code.
- Édition via le terminal.

### 4.4 `marexssh` — SSH + SFTP (PVE)

- Utilisateur système `marexssh`, `StateDirectory=/var/lib/marexssh`, écoute **127.0.0.1:8791** uniquement.
- Sandbox systemd : `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`, `MemoryMax`, `TasksMax`.
- Dépendances : `ssh2`, `ws`, xterm.js local.
- **Authentification** : header `Tailscale-User-Login` (injecté par Serve, non falsifiable) ∈ `admin_tailscale_logins` ; cookie maître validé via gate (HMAC) ; session liée à l’appareil ; CSRF.
- **Politique réseau** : destinations `100.64.0.0/10`, `10.0.0.0/24`, `192.168.1.0/24` ; ports 22/2222 ; refus loopback/link-local/métadonnées/IP publiques ; résolution puis connexion à l’IP validée (anti-rebinding).
- **SSH** : clés d’hôte épinglées (TOFU, SHA256) ; clé changée = blocage ; pas d’agent/port/X11 forwarding ; timeouts connexion 10 s, auth 15 s, inactivité 15 min, max 8 h ; 3 sessions/appareil.
- **Identifiants** : mot de passe ou clé en mémoire uniquement, effacés après auth, jamais loggés ; coffre AES-256-GCM plus tard.

**SFTP**

- Liste, fil d’Ariane, tri, rafraîchir.
- Upload (mono/multi, glisser-déposer), download, renommer, nouveau dossier, dupliquer, aperçu lecture seule.
- **Pas de suppression, pas de chmod, pas d’éditeur.**
- Écrasement : refus 409, puis confirmation explicite → `overwrite=1`.
- Racine : home distant par défaut ; bouton « Afficher la racine » → step-up maître, valable pour la session.
- `realpath` + refus des symlinks sortant de la racine.
- Streaming uniquement (aucun fichier stocké), max 2 Go/transfert, 2 transferts simultanés, aperçu 256 Ko.
- Aperçu texte via `textContent`, images en blob de types sûrs ; **jamais de HTML/SVG distant** ; téléchargements en `attachment`.
- Audit : chemin, taille, sens, résultat — sans contenu.
- Erreurs : Tailscale requis, identité non admin, destination refusée, clé inconnue/changée, droits refusés, existe déjà, espace insuffisant, trop volumineux, timeout, session expirée.

### 4.5 Réseau, Tailscale, ACL

- 102 : vhosts `allow 10.0.0.105; allow 127.0.0.1; deny all;` (le `.1`/SNAT tailnet est retiré).
- 102 : sshd désactivé (ou loopback).
- Serve : `/` → 105:80 ; `/ssh` → 127.0.0.1:8791.
- Identité admin obligatoire côté proxy ; tagged devices refusés.
- ACL Tailscale (snippet fourni) : Serve réservé à l’admin ; accès subnet limité aux ports nécessaires ; **refus explicite 10.0.0.102:22**.
- MFA sur le compte Tailscale, approbation des appareils, tailnet lock.

### 4.6 Durcissement transverse

- CSP stricte (JS/CSS externalisés, assets locaux, `frame-src 'self'`, `connect-src 'self'`, `img-src 'self' blob: data:`), XFO `SAMEORIGIN`, XCTO, Referrer-Policy, Permissions-Policy, HSTS.
- CSRF + `Origin` + `SameSite=Strict`.
- Jails fail2ban `marexgate`, `marexssh` ; rate limits nginx/app.
- Audit + alertes ; rotation ; sauvegardes chiffrées.

---

## 5. Modèle de données et configuration

**Gate (SQLite)** : `devices`, `sessions`, `webauthn_credentials`, `audit`.

**Proxy** : `known_hosts.json` (0600), sessions en mémoire, audit JSONL.

**Config** `/etc/marexcode/security.json` (0640 root:marexgate:marexssh) :

```json
{
  "trust_days": 30,
  "max_trust_days": 90,
  "admin_tailscale_logins": ["admin@exemple"],
  "ssh": {
    "allowed_cidrs": ["100.64.0.0/10", "10.0.0.0/24", "192.168.1.0/24"],
    "allowed_ports": [22, 2222],
    "idle_timeout_min": 15,
    "max_session_min": 480,
    "max_sessions": 3,
    "sftp": {
      "max_bytes": 2147483648,
      "preview_bytes": 262144,
      "concurrent": 2
    }
  }
}
```

Secret HMAC proxy : `/etc/marexcode/proxy.key`.

---

## 6. Parcours utilisateur

1. **Première visite** : basic auth → page → overlay maître → mot de passe (+TOTP) → passkey proposée → « se souvenir 30 j » → terminaux chargés.
2. **Visite suivante** : appareil de confiance → terminaux chargés sans prompt (passkey si step-up).
3. **Révocation** : panneau Appareils (step-up) → révocation → WS fermés → overlay.
4. **SSH** : URL `ts.net` → bouton SSH → modal (Terminal/SFTP) → IP/port/user/clé ou mot de passe → contrôles Tailscale + maître + politique + clé d’hôte → session.
5. **SFTP** : onglet SFTP → navigation → upload/download/renommer/dossier/dupliquer/aperçu → « Afficher la racine » via step-up → écrasement confirmé.
6. **URL publique** : SSH absent ; message + lien vers l’URL Tailscale.

---

## 7. API (résumé)

**Gate** : `/status`, `/login`, `/logout`, `/step-up`, `/webauthn/*`, `/devices`, `/verify`, `/verify-proxy`.

**Proxy SSH/SFTP** :

```
POST /connect
POST /hostkey/confirm
GET  /ws/:session
GET  /sftp/list?session&path
GET  /sftp/file?session&path          (download)
PUT  /sftp/file?session&path&overwrite=0|1
POST /sftp/rename | /sftp/mkdir | /sftp/duplicate
GET  /sftp/preview?session&path
POST /sftp/root                       (step-up)
POST /disconnect
```

Aucun endpoint delete/chmod/edit.

---

## 8. Phases, livrables et tests

| Phase | Contenu | Durée | Tests clés |
|---|---|---|---|
| **0. Préparation** | Backups, users/dossiers, config, deps locales, plan ACL | 0,5 j | Restauration testée |
| **1. Socle gate** | `marexgate`, CLI, DB, sessions, appareils, TTL, WebAuthn/TOTP, overlay, `auth_request` terminal + browser, FileBrowser read-only/dotfiles, sshd 102, allow-list 102, headers/CSRF, jails | 2–3 j | WS sans cookie refusé ; TTL/révocation ; écriture FileBrowser 403 ; dotfiles 403 ; non-régression page/terminaux |
| **2. Application live + ops** | `marexws` (expiration/révocation en direct), UI appareils/step-up, alertes, ACL Tailscale | 1–2 j | Révocation coupe le WS ; expiration coupe ; step-up ; ACL admin |
| **3. SSH + SFTP** | `marexssh` sandboxé, Serve `/ssh`, identité admin, UI, politique réseau, clés d’hôte, SFTP complet, racine step-up, écrasement confirmé | 4–6 j | Refus hors Tailscale/non-admin/hors CIDR ; clé changée bloquée ; upload/download/rename/mkdir/dup ; delete/chmod 404 ; symlink escape bloqué ; preview sans XSS ; révocation coupe transfert |
| **4. Validation** | Revue sécurité, tests d’intrusion, docs, runbooks, backups, répétition rollback | 1–2 j | Matrice complète + mobile |

### Découpage d’exécution adopté (pas à pas)

| Étape | Contenu | État |
|---|---|---|
| 1. Fermeture des contournements | FileBrowser read-only + dotfiles, 102 limité à 105/loopback, sshd 102 (conservé) | ✅ appliquée le 2026-10-30 |
| 2. Socle `marexgate` | Service, CLI, DB, sessions, appareils, TTL, audit | ✅ appliquée le 2026-10-30 |
| 3. Maître imposé | `auth_request` terminal + fichiers, overlay, TOTP | ✅ appliquée le 2026-10-30 (3a) |
| 3b. Passkey WebAuthn | Enrôlement + connexion biométrique | ✅ appliquée le 2026-10-31 |
| 4. Live + appareils | `marexws`, révocation/expiration en direct, UI, step-up, alertes | ✅ appliquée le 2026-10-31 |
| 5. Durcissement web | CSP par hachages, en-têtes, CSRF/Origin, rate limit gate, logrotate | ✅ appliquée le 2026-10-31 |
| 6. SSH | Proxy PVE, Serve `/ssh`, identité admin, ticket HMAC, UI, garde-fou 102:22 (désactivé le 2026-10-31) | ✅ appliquée le 2026-10-31 |
| 7. SFTP | Onglet, upload/download/rename/copie/aperçu, sans suppression, step-up racine | ✅ appliquée le 2026-10-31 |
| 8. Validation | Tests, revue sécurité, runbooks, rollback drill | ✅ appliquée le 2026-10-31 |

### sshd 102 (choix : garder) — garde-fou désactivé le 2026-10-31

- But : garder l’accès admin depuis l’hôte (`10.0.0.1`) mais empêcher le tailnet d’atteindre `10.0.0.102:22`.
- Méthode A (recommandée) : ACL Tailscale — restreindre les grants subnet pour exclure `10.0.0.102:22` (à adapter à l’ACL actuelle ; l’ACL est allow-only, pas de règle « deny »).
- Méthode B (garde-fou réseau sur PVE) : bloquer le trafic forwardé du tailnet vers ce port :
  `iptables -I FORWARD -i tailscale0 -d 10.0.0.102 -p tcp --dport 22 -j DROP`
  (à persister au boot ; l’accès hôte→102:22 reste hors FORWARD donc autorisé). À tester depuis un appareil tailnet et depuis l’hôte avant validation.

---

## 9. Rollback

- Backups avant chaque phase : nginx 102/105, units, DB gate, DB FileBrowser, page, config.
- Phase 2 : `systemctl disable --now marexgate` puis retirer `/opt/marexgate`,
  `/var/lib/marexgate`, `/etc/marexcode`, `/usr/local/bin/marexgate`,
  `/etc/systemd/system/marexgate.service` puis `systemctl daemon-reload`.
- Phase 3 : restaurer `/root/marexcode.conf.bak-phase3-*` (105 et 102) puis
  `nginx -t && systemctl reload nginx` (retire `/gate/`, `auth_request`) ;
  page : restaurer depuis `/root/phase1-backups/105-*.tgz` (ancienne page).
  La DB gate et le maître restent intacts.
- Phase 7 : restaurer `/opt/marexssh/server.js` (`/root/p7-server-ssh.js.bak-*`),
  `/etc/marexssh/config.json` (`/root/p7-config.json.bak-*`), `/root/p7-server.js.bak-*`
  (102, gate) et `/root/marexcode.conf.bak-p7-*` (102, `/_gate/verify-neva`) ;
  restaurer `/var/www/marexcode-web/ssh-ui/index.html` + `app.js` (iframe), la page
  parente et sa CSP ; `systemctl restart marexssh marexgate nginx`.
- Phase 6 : `systemctl disable --now marexssh marex-tailnet-guard.timer` ;
  `tailscale serve --https=8443 --set-path=/ssh off` ;
  retirer `/opt/marexssh`, `/etc/marexssh`, `/var/lib/marexssh`,
  `/usr/local/sbin/marexssh`, les units `marexssh`/`marex-tailnet-guard*`,
  `/usr/local/sbin/marex-tailnet-guard`, et la règle FORWARD ; restaurer
  `/root/marexcode.conf.bak-p6-*` (105) ; `userdel marexssh`.
- Phase 5 : restaurer `/root/marexcode.conf.bak-p5-*` et
  `/root/ttyd-ratelimit.conf.bak-p5-*` (105), retirer
  `/usr/local/sbin/marexcode-web-deploy`, `/usr/local/sbin/marexcode-csp.py`,
  les snippets `marexcode-page-headers*.conf`/`marexcode-csp.conf` et
  `/etc/logrotate.d/marexgate` ; restaurer `/root/p5-server.js.bak-*` (102).
  Si la page change ensuite, régénérer la CSP (sinon page bloquée par CSP).
- Phase 3b : restaurer `/root/p3b-lib.js.bak-*`, `/root/p3b-server.js.bak-*` (102)
  et retirer `/opt/marexgate/webauthn.js` + le paquet `@simplewebauthn`
  (`npm uninstall @simplewebauthn/server`) ; la table migrée reste compatible
  (vide). Les passkeys peuvent aussi être supprimées via l’UI.
- Phase 4 : `systemctl disable --now marexws` ; restaurer
  `/root/marexcode.conf.bak-p4-*` (102 nginx, `/terminal/N/` → `768N`) puis
  `nginx -t && systemctl reload nginx` ; la page peut rester (bouton Appareils
  inopérant). DB inchangée : `/root/phase4-gate-backup.db` pour un retour complet.
- Désactivation : retirer `auth_request`, restaurer permissions FileBrowser, réactiver sshd si nécessaire, retirer `/ssh` de Serve, arrêter `marexssh`/`marexws`.
- Alerts : supprimer `/etc/marexcode/alerts.env` (revient au mode silencieux).
- Base gate conservée pour revenir en arrière sans perdre les appareils.
- ACL/routes : restaurer la configuration Tailscale précédente.

---

## 10. Risques résiduels assumés

- `sam` sudoer : maître compromis = compte complet (sudo demande encore le mot de passe système).
- Routes LAN conservées : autres LXC joignables depuis le tailnet ; hors périmètre, à couvrir par ACL.
- Deux origines (`example.com` / `ts.net`) : cookies/passkeys distincts ; `ts.net` recommandé comme URL principale.
- Proxy SSH sur l’hôte PVE : service sandboxé mais hors LXC ; un root PVE peut lire la clé HMAC.
- Revalidation SSH fail-open si le gate est injoignable (session maintenue jusqu’à idle/max).
- SFTP sans suppression : volontaire ; contournement possible par renommage/écrasement (pas de destruction).
- `ts.net`/passkeys non testés de bout en bout depuis 102 (102 n’atteint pas le listener Serve).

---

## 11. Runbooks

Commandes `marexgate` : root sur **102**. `marexssh` : root sur **PVE**.

### Maître
- Définir/changer : `sudo marexgate passwd` (saisie masquée). Révoque les sessions, conserve les passkeys.
- Oublié : `sudo marexgate reset` → révoque les appareils **et supprime les passkeys**, efface maître/TOTP ; puis `sudo marexgate passwd`.
- TOTP perdu : `sudo marexgate totp-disable` puis `sudo marexgate totp-setup` si besoin.

### Appareils
- Lister : `sudo marexgate devices` ou UI « Appareils ».
- Révoquer : UI (step-up) ou `sudo marexgate revoke <id|all>`.
- Effet : terminaux web ≤ ~10 s ; SSH/SFTP ≤ ~30 s. Audits : `terminal_ws_closed`, `ssh_session_revoked`.

### Passkeys
- Lister : `sudo marexgate passkeys` ; supprimer une via l’UI (step-up) ; tout : `sudo marexgate passkeys-clear`.
- Perdue : utiliser le maître ; si plus d’accès : `reset` puis ré-enrôlement.

### Panic
```
sudo marexgate panic          # révoque appareils + supprime passkeys
sudo marexgate passwd         # nouveau maître
sudo systemctl stop marexssh  # coupe les sessions SSH
sudo tailscale serve --https=8443 --set-path=/ssh off
```
Vérifier ensuite `tailscale serve status`, les audits gate/ssh et les services.

### Clé d’hôte SSH
- `sudo marexssh known-hosts`
- Changement légitime vérifié hors bande : `sudo marexssh forget <hôte:port>` (redémarre le service, coupe les sessions).
- Changement inexpliqué : ne pas oublier, investiguer (MITM/rebuild).

### Certificats (105)
- `certbot certificates` ; `certbot renew --dry-run`.

### Fail2ban (105)
- `fail2ban-client status` ; `fail2ban-client set <jail> unbanip <ip>`.
- ignoreip : `/etc/fail2ban/jail.d/nginx-ttyd.local` et `nginx-marexgate.local` (loopback, IP publique, `10.0.0.0/24`, `10.0.1.0/24`, `192.168.1.0/24`).

### Services / santé
- 102 : `systemctl status marexgate marexws nginx filebrowser-marexcode netdata 'ttyd-marexcode@1'` ; `curl -s 127.0.0.1:8789/health` ; `nginx -t`.
- PVE : `systemctl status marexssh marex-tailnet-guard.timer tailscaled` ; `curl -s 127.0.0.1:8791/health` ; `tailscale serve status` ; `iptables -C FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp --dport 22 -j DROP`.
- 105 : `nginx -t` ; `systemctl status nginx fail2ban`.

### Déploiement page
- `pct push 105 <source> /var/www/marexcode-web/index.html` puis `pct exec 105 -- /usr/local/sbin/marexcode-web-deploy` (recalcule la CSP — obligatoire).
- Iframe SSH : `ssh-ui/index.html` + `app.js`.

### Audit / logs
- `/var/lib/marexgate/audit.jsonl` (logrotate hebdo) ; `/var/lib/marexssh/audit.jsonl` ; `journalctl -u marexgate|marexws|marexssh -f` ; nginx 105 `marexcode.access.log` (fail2ban).

### Sauvegarde / restauration
- Backups : `/root/phase1-backups/`, `/root/phase3-gate-backup/`, `/root/phase4-gate-backup.db` (VACUUM INTO), `/root/*.bak-*` (nginx 102/105, gate, proxy, config), `/root/p6-known_hosts.bak`.
- Gate DB : arrêter marexgate, restaurer `gate.db` (ou `.db`+`-wal`+`-shm`), `chown marexgate:marexgate`, `chmod 600`, démarrer.
- Proxy/gate : réinstaller le `.js` sauvegardé, `node --check`, redémarrer.
- Nginx : réinstaller le `.conf` sauvegardé, `nginx -t`, reload.

### Ajout d’un admin Tailscale SSH
- Éditer `/etc/marexssh/config.json` (`admins`), `systemctl restart marexssh`.

### Rotation des secrets
- HMAC SSH : même contenu dans `/etc/marexcode/proxy.key` (102) et `/etc/marexssh/proxy.key` (PVE), 0640, puis redémarrer `marexgate` et `marexssh`.

Référence rollback complet : section 9.

---

## 12. Hors périmètre / plus tard

- Coffre chiffré des clés SSH (AES-256-GCM dérivé du maître).
- TOTP obligatoire (aujourd’hui optionnel).
- Utilisateur web dédié sans `sudo`.
- Remplacement du basic auth par le seul gate.
- ACL détaillées pour les autres LXC exposés par les routes LAN.

---

## 13. Reste à faire — plan d’exécution enregistré (2026-10-31)

**État** : phases 1, 2 et 3a appliquées. Gate maître imposé sur terminal + fichiers.
Le bouton **SSH** n’existe pas encore : il arrive en phase 6 (demande notée, non
anticipée pour ne pas livrer un panneau non fonctionnel).

**Ordre retenu (celui de ce fichier)** : 3b → 4 → 5 → 6 → 7 → 8.

### 3b. Passkey WebAuthn — ✅ appliquée le 2026-10-31

- ✅ `@simplewebauthn/server` 14.0.3 ; module `webauthn.js` ; challenges en mémoire 3 min.
- ✅ RP/origine par Host (`config.webauthn.origins`) : deux domaines, passkeys distinctes
  par domaine (caveat documenté et affiché dans l’UI).
- ✅ Endpoints enrôlement/connexion/liste/suppression ; step-up pour supprimer.
- ✅ UI : bouton passkey sur l’écran de verrouillage + bloc « Passkeys » dans Appareils.
- ✅ Déverrouillage passkey → même jeton d’appareil/TTL ; repli maître toujours possible.
- ✅ Tests authentificateur virtuel CDP ; `ts.net` non testable de bout en bout depuis 102.
- ✅ Correction : `marexws` et les TTL > 24,8 j (timer `setTimeout` dépassant 2^31-1 ms).

### 4. Révocation/expiration en direct + UI appareils

- ✅ `marexws` (127.0.0.1:7691–7694 → ttyd 7681–7684) : validation au handshake,
  revalidation toutes les 10 s, fermeture à l’expiration/révocation ; nginx pointe vers `769N`.
  Le cookie n’est pas stocké : chaque revalidation interroge `GET /verify` (source unique).
- ✅ UI « Appareils » : nom, IP, dernière activité, expiration, badge « cet appareil »,
  révoquer, tout révoquer, verrouiller ; **step-up** maître (jeton 5 min) pour les autres.
- ✅ Alertes Telegram (nouvel appareil, révocation, trop de tentatives) ; en plus des
  alertes fail2ban de l’hôte.
- ✅ Jail `nginx-marexgate` (POST /gate/login 401) sur 105 ; `nginx-ttyd` ignore ces lignes.
- Passkeys : suppression dans l’UI (step-up) — appliquée en 3b.

### 5. Durcissement web — ✅ appliquée le 2026-10-31

- ✅ CSP stricte **par hachages** (blocs inline) ; pas d’`unsafe-inline`.
  `marexcode-web-deploy` régénère la CSP (obligatoire après édition de la page).
- ✅ XCTO, XFO `DENY`, Referrer-Policy, Permissions-Policy, COOP/CORP, HSTS.
- ✅ CSRF sur logout/step-up/actions authentifiées + contrôle **Origin** des POST
  (liste blanche, audit). ✅ Rate limit nginx dédié `/gate/` (5 r/s) + app.
- ✅ Logrotate de l’audit gate ; `npm audit` 0 vulnérabilité.
- ✅ Tests de non-régression complets (0 violation CSP).

### 6. SSH (terminal distant) — ✅ appliquée le 2026-10-31

- ✅ Bouton **SSH** (header) ; modal sur le public = message + lien tailnet ;
  sur `ts.net` = iframe isolée `/ssh-ui/` (xterm.js, ticket via postMessage).
- ✅ Identité admin `admin@example.com` exigée (`Tailscale-User-Login`).
- ✅ `marexssh` sur PVE (`127.0.0.1:8791`, Node 24 dédié `/opt/marexssh`, user
  `marexssh`, unité sandboxée) ; Serve `/ssh` conservant `/` → 105:80.
- ✅ Ticket **HMAC 60 s à usage unique** (`/gate/ssh/ticket`, clé `proxy.key`),
  vérifié par le proxy ; source Serve loopback + identité.
- ✅ Politique destinations/ports, IPv4, anti-rebinding, refus loopback/link-local.
- ✅ Clés d’hôte épinglées (TOFU), mismatch = blocage + CLI `marexssh forget`.
- ✅ Pas d’agent/port/X11 ; idle/max sessions ; identifiants mémoire ; audit sans secret.
- ✅ Garde-fou tailnet→`10.0.0.102:22` (iptables + timer systemd).

### 7. SFTP — ✅ appliquée le 2026-10-31

- ✅ Onglet SFTP sur la même connexion SSH (`sftp` ssh2).
- ✅ Liste/navigation, upload (multi + drag & drop), download, renommer,
  nouveau dossier, dupliquer, aperçu lecture seule.
- ✅ **Pas de suppression, pas de chmod, pas d’éditeur** ; upload écrasement
  `409` puis confirmation ; rename/copie refusent d’écraser.
- ✅ Home par défaut ; racine via **step-up** (ticket `sftp_root` HMAC) ;
  `realpath` + refus des symlinks sortants.
- ✅ Streaming 2 Go, 2 transferts, aperçu 256 Ko, jetons de session/URL.
- ✅ Aperçu jamais HTML/SVG rendu (`text/plain` + `nosniff`), downloads `attachment`.
- ✅ Révocation en direct via revalidation gate 30 s (coupe session + transferts).
- ✅ Tests backend + UI desktop/mobile, 0 violation CSP.

### 8. Validation — ✅ appliquée le 2026-10-31

- ✅ Matrice auth/terminal/fichiers/SSH/SFTP/mobile/réseau rejouée (voir Suivi phase 8).
- ✅ Revue sécurité : surface réseau, en-têtes/CSP, CSRF/Origin, rate limits,
  fail2ban, permissions, durcissement systemd, `npm audit`, TLS, backups.
- ✅ Runbooks détaillés (section 11) ; CLI `passkeys`/`passkeys-clear`/`panic`.
- ✅ Répétition rollback gate + proxy (restauration, santé, remise en place).
- ✅ Documentation à jour (plan, brain Operator).

### Rappels ouverts

- Passkey par origine (deux origines) ; le maître reste le repli universel.
- Web : révocation ≤ ~10 s (`marexws`) ; SSH/SFTP : ≤ ~30 s (revalidation gate).
- `sshd 102` conservé pour l’admin host ; tailnet→`10.0.0.102:22` **débloqué** le 2026-10-31 (garde-fou désactivé, à la demande).
- Basic auth reste la première couche ; fichiers directs redirigés vers la page gatée.
- Revalidation SSH : **fail-open** si le gate est injoignable (session maintenue) — choix anti-incident réseau.
- Sauvegardes : `/root/phase1-backups/`, `/root/phase3-gate-backup/`, `/root/phase4-gate-backup.db`,
  `/root/*.bak-*` (nginx 102/105, gate, proxy, config), `/root/p6-known_hosts.bak`.
