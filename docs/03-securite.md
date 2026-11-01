# 03 — Sécurité

## Modèle en couches

```
Internet
  │  1. TLS (Let's Encrypt, 105) + HSTS
  │  2. Basic auth nginx (marex) + fail2ban (401)
  │  3. Portail maître (marexgate) : mot de passe Argon2id
  │     + TOTP optionnel + passkeys WebAuthn
  │  4. Cookie d'appareil (__Host-marexgate), TTL 30 j (max 90)
  │  5. nginx auth_request sur terminal + fichiers
  │  6. marexws : revalidation du cookie toutes les 10 s
  ▼
Terminaux / fichiers (102)
```

Chaque couche est indépendante : si le maître est compromis, le Basic auth reste ;
si le Basic auth est deviné, le portail reste ; une session révoquée est coupée en
≤ 10 s (web) / ≤ 30 s (SSH).

## Basic auth (105)

- Fichier `/etc/nginx/.htpasswd-marexcode` (040 ou 0640 root:www-data), utilisateur **`marex`**.
- Appliqué à **tous** les vhosts 105 (page, fichiers, stats, ts.net).
- C'est la première barrière, **avant** le portail.
- Changer le mot de passe : voir `11-runbooks.md` (`openssl passwd -apr1`).

## Portail maître (`marexgate`, 102)

- **Mot de passe maître** : Argon2id (`memoryCost 65536`, `timeCost 3`, `parallelism 1`).
  Jamais stocké en clair, seulement le hash dans `gate.db` (`settings.master_hash`).
- **TOTP** optionnel (SHA1, 6 chiffres, 30 s, fenêtre ±1) ; secret dans `gate.db`.
- **Passkeys WebAuthn** (`@simplewebauthn/server` 14) :
  - RP ID/origine par `Host` : `marexcode.example.com` → `https://marexcode.example.com` ;
    `neva.example-tailnet.ts.net` → `https://neva.example-tailnet.ts.net:8443` ; autre Host refusé.
  - Challenge en mémoire 3 min, usage unique ; compteur d'authentificateur mis à jour.
  - **Une passkey est liée à son domaine** : celle créée sur `marexcode...` ne marche pas
    sur `ts.net`, et inversement.
- **Appareils** : chaque login (maître ou passkey) crée un appareil avec :
  - `token` aléatoire 32 octets (hash SHA-256 en base),
  - `csrf_secret`,
  - `trust_until` (TTL 30 j par défaut, max 90 ; 0 = session 12 h),
  - nom, dernière IP, user-agent, `revoked_at`.
- **Cookie** `__Host-marexgate` : `Secure; HttpOnly; SameSite=Strict; Path=/`,
  sans `Domain` (host-only), donc **un cookie par origine** (public vs ts.net).
- **Révocation** : appareil, « tout révoquer », ou `marexgate revoke|panic`.
  - Web : `marexws` revalide `/verify` toutes les 10 s → WS fermée.
  - SSH/SFTP : `marexssh` revalide `/_gate/verify-neva` toutes les 30 s → session coupée.
  - UI : poll `/gate/status` toutes les 60 s → verrouillage.
- **Step-up** : re-saisie du maître + TOTP → jeton mémoire 5 min, requis pour
  révoquer un **autre** appareil, tout révoquer, supprimer une passkey, ou
  demander un ticket `sftp_root`.
- **Rate limiting** : 10 échecs de mot de passe / 10 min par IP réelle (429) ;
  passkeys 20 échecs / 10 min. En plus : nginx `gate` 5 r/s (burst 10) sur `/gate/`.
- **CSRF** : `X-CSRF` exigé sur logout, step-up, révocation, passkeys, tickets SSH.
  `/login` et `/webauthn/login/*` n'en ont pas (pas de session) mais subissent le
  contrôle **Origin**.
- **Origin** : tous les POST vérifient `Origin` contre les deux origines autorisées ;
  une Origin inconnue → `403 bad_origin` + audit `post_origin_denied`. Sans Origin
  (curl/CLI) c'est accepté.
- **Alertes Telegram** : nouvel appareil, révocation, trop de tentatives
  (`/etc/marexcode/alerts.env`, 0640 root:marexgate). Supprimer le fichier = silence.

## Nginx / web

- **En-têtes page** (105) : CSP stricte, XCTO `nosniff`, XFO `DENY`,
  Referrer-Policy `no-referrer`, Permissions-Policy (tout off), COOP/CORP
  `same-origin`, HSTS, `Cache-Control: no-store`.
- **CSP par hachages** : `default-src 'none'`, `script-src 'self' + sha256`,
  `style-src 'self' + sha256`, `frame-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
  Toute modification de la page impose `marexcode-web-deploy` (recalcul des hachages).
- **Iframe SSH** `/ssh-ui/` : CSP propre (styles inline autorisés pour xterm),
  `frame-ancestors 'self'`, XFO `SAMEORIGIN`.
- **Rate limit** : `ttyd` 20 r/s burst 50 (page + iframe + métriques),
  `gate` 5 r/s burst 10 ; au-delà → 429.
- **Real IP** : 105 `set_real_ip_from 10.0.0.1; real_ip_header proxy_protocol;`
  → les logs/fail2ban voient l'IP client, pas 10.0.0.1.
- **Fail2ban (105)** :
  - `nginx-ttyd` : 401 Basic, 5 échecs/10 min, ban 1 h, ignore loopback, IP publique
    du serveur, `10.0.0.0/24`, `10.0.1.0/24`, `192.168.1.0/24`.
  - `nginx-marexgate` : 401 de `POST /gate/login`, 8/10 min, mêmes ignoreip.
  - `nginx-ttyd` ignore les lignes `/gate/login` (pas de double comptage).

## SSH distant (`marexssh`, PVE)

- **Exposition** : `127.0.0.1:8791` uniquement, via Tailscale Serve `/ssh` (tailnet).
- **Identité** : `Tailscale-User-Login` doit être `<admin-tailscale>`
  (injecté par Serve ; Serve supprime toute valeur fournie par le client).
- **Ticket** : signé HMAC-SHA256 par le gate (`proxy.key`), payload
  `{v, sub=device, exp:+60s, nonce}`, **usage unique** (nonce mémorisé), vérifié
  constant-time. Un ticket `sftp_root` exige en plus un step-up.
- **Destinations** : IPv4 uniquement, résolues une fois, **toutes** les adresses
  doivent être dans `100.64.0.0/10`, `10.0.0.0/24`, `192.168.1.0/24` ;
  ports 22/2222. Loopback/link-local/métadonnées/public refusés.
- **Anti-rebinding** : la connexion utilise l'IP résolue, pas le nom.
- **Clés d'hôte** : TOFU épinglé (`known_hosts.json`) ; changement = blocage avec
  les deux empreintes ; `marexssh forget <hôte:port>` après vérification hors bande.
- **Pas d'agent/port/X11 forwarding** ; shell + SFTP seulement.
- **Limites** : 3 sessions/appareil, 6/login, idle 15 min, max 480 min.
- **Identifiants** : mot de passe/clé en mémoire uniquement, jamais journalisés ;
  l'audit ne contient que login, device, destination, événement.
- **Revalidation** : cookie device renvoyé à `/_gate/verify-neva` (102, allow
  `10.0.0.1`) toutes les 30 s ; 401 → session coupée. **Fail-open** si le gate
  est injoignable (choix : ne pas couper sur incident réseau).
- **Garde-fou** : la règle `iptables -I FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp
  --dport 22 -j DROP` + timer a été **désactivée le 2026-10-31** : le tailnet peut
  de nouveau atteindre sshd 102 directement. Le proxy SSH web reste indépendant.

## SFTP

- Même connexion SSH (`sftp` ssh2), jeton de session aléatoire (mémoire, jamais loggé).
- **Pas de suppression, pas de chmod, pas d'éditeur.**
- Upload : `409` si le fichier existe, puis confirmation → `X-Marex-Overwrite: 1`.
- Renommage/copie : refus si la destination existe.
- **Confinement** : `realpath` + racine = home ; tout chemin/symlink sortant refusé
  (`outside_root`). « Afficher la racine » = ticket `sftp_root` après step-up.
- **Transferts** : 2 Go max, 2 simultanés, aperçu 256 Ko.
- **Aperçu** : jamais HTML/SVG rendu ; tout est `text/plain` + `nosniff`, images en
  blob ; téléchargement en `attachment`.
- **Téléchargements** : URL à usage unique, 60 s.
- **Révocation** : coupe la session et les transferts (via la revalidation).

## Secrets — résumé (détail dans `15-secrets.md`)

| Fichier | Mode | Sensibilité |
|---|---|---|
| `/etc/marexcode/proxy.key` (102) | 0640 root:marexgate | HMAC tickets SSH |
| `/etc/marexssh/proxy.key` (PVE) | 0640 root:marexssh | idem |
| `/etc/marexcode/alerts.env` (102) | 0640 root:marexgate | token Telegram |
| `/var/lib/marexgate/gate.db` (102) | 0600 marexgate | hash maître, jetons, passkeys |
| `/etc/nginx/.htpasswd-marexcode` (105) | 0640 root:www-data | Basic auth |
| `/etc/letsencrypt/` (105) | root | clés TLS + compte ACME |
| `/var/lib/marexssh/known_hosts.json` | 0600 marexssh | empreintes SSH |
| `/var/lib/tailscale/tailscaled.state` (PVE) | root | clé du nœud (hors bundle) |

## Risques résiduels assumés

- `sam` est sudoer sur 102 : maître compromis = compte complet (sudo redemande le
  mot de passe système).
- Le Basic auth reste la première couche ; il n'a pas de MFA propre.
- Passkeys par origine (deux domaines) ; le maître reste le repli universel.
- `ts.net` et les passkeys ne sont pas testables de bout en bout depuis 102.
- Revalidation SSH fail-open si le gate est injoignable.
- Root sur PVE peut lire la clé HMAC ; File Browser est archivé (plus de patchs)
  mais en lecture seule.
- `sshd` sur 102 est conservé pour l'admin depuis l'hôte ; le tailnet y est bloqué.

## Checklist sécurité (à refaire après changement)

- [ ] Page 401 sans Basic auth ; 200 avec.
- [ ] `/gate/status` verrouillé sans cookie.
- [ ] Terminal/fichiers 401 sans cookie ; 200 avec.
- [ ] `/ssh` non exposé sur le domaine public ; `/ssh-ui/` 404 public.
- [ ] CSP sans violation (console navigateur).
- [ ] En-têtes page présents (CSP, XCTO, XFO, HSTS…).
- [ ] Ports 102 sensibles refusés depuis PVE.
- [ ] `fail2ban-client status` : jails actives, ignoreip internes.
- [ ] `marexgate status` : maître configuré, appareils attendus.
- [ ] `marexssh known-hosts` : empreintes attendues.
- [ ] Certs > 30 jours ; `certbot renew --dry-run`.
- [ ] `npm audit` = 0 (gate + ssh).

## Mise à jour 2026-10-31

- **CSP** : `script-src` reste strict (hachages + `'self'`) ; `style-src` passe à
  `'self' 'unsafe-inline'` (Monaco injecte des styles) ; ajout de
  `worker-src 'self' blob:`. Générateur : `/usr/local/sbin/marexcode-csp.py`.
- **Assets publics** : `/browser/static/` (JS/CSS/icônes/`custom.css`) est servi
  **sans gate** car non sensible — le HTML et l'API restent gatés (`auth_request`).
  Vérifs : asset 200 sans cookie, API 401 sans cookie.
- **Cache** : `assets/` 1 an immutable, `img/` 1 jour, `custom.css` no-cache.
  Le `no-store` du vhost ne s'applique plus au statique.
- **Branding** : nom/logo seulement, aucun impact sécurité ; liens externes masqués.
- **Thèmes** : variables CSS + `localStorage` ; aucune donnée sensible.
- Les 6 thèmes ne changent ni le gate, ni les cookies, ni les permissions.
