# 05 — Le portail `marexgate`

## Emplacement et service

| Élément | Valeur |
|---|---|
| Hôte | LXC 102 |
| Code | `/opt/marexgate/` (`server.js`, `lib.js`, `webauthn.js`, `marexws.js`, `cli.js`) |
| Dépendances | `@node-rs/argon2` 2.2.2, `@simplewebauthn/server` 14.0.3, `node:sqlite` |
| Service | `marexgate.service` (user `marexgate`), `127.0.0.1:8789` |
| Config | `/etc/marexcode/security.json` (0640 root:marexgate) |
| Clé HMAC | `/etc/marexcode/proxy.key` (0640 root:marexgate) |
| Alertes | `/etc/marexcode/alerts.env` (0640 root:marexgate) |
| Base | `/var/lib/marexgate/gate.db` (0600 marexgate, WAL) |
| Audit | `/var/lib/marexgate/audit.jsonl` (0600, logrotate hebdo) |
| CLI | `/usr/local/bin/marexgate` (wrapper sudo + setpriv) |

## Base de données (`gate.db`)

- `settings(key,value)` : `master_hash` (Argon2id), `totp_secret`, `totp_enabled`,
  `trust_days` (30), `max_trust_days` (90), `webauthn_user_id`.
- `devices(id,name,token_hash,csrf_secret,created_at,last_seen_at,last_ip,
  user_agent,trust_until,revoked_at)`.
- `webauthn_credentials(id,device_id,credential_id,public_key,counter,transports,
  rp_id,name,created_at,last_used_at)`.
- `audit(id,ts,event,ip,device_id,detail)` (aussi écrit en JSONL).

Le hash maître n'est **jamais** réversible. `gate.db` contient des secrets :
à sauvegarder/chiffrer.

## CLI (`sudo marexgate ...` sur 102)

| Commande | Effet |
|---|---|
| `status` | maître configuré, TOTP, TTL, nombre d'appareils actifs |
| `passwd` | change le maître (interactif, ≥12 car.), **révoque les sessions**, garde les passkeys |
| `devices` | liste les appareils (id, nom, dates, IP, état) |
| `revoke <id|all>` | révoque un appareil ou tous |
| `ttl <jours>` | TTL par défaut (0..max) |
| `totp-setup` / `totp-disable` | active (affiche secret + URI) / désactive le TOTP |
| `passkeys` | liste les passkeys (id, nom, domaine, dates) |
| `passkeys-clear` | supprime toutes les passkeys |
| `panic` | révoque tous les appareils **et** supprime toutes les passkeys (urgence) |
| `reset` | efface maître/TOTP, révoque les appareils, supprime les passkeys |
| `help` | usage |

Le wrapper gère `sam` → `sudo` → `setpriv --reuid=marexgate` (`/sbin` n'est pas dans
le PATH de `sam` ; ne pas utiliser `runuser`).

## API HTTP (sur `127.0.0.1:8789`, proxifiée par `/gate/`)

| Méthode | Chemin | Auth | Rôle |
|---|---|---|---|
| GET | `/health` | — | `{ok:true}` |
| GET | `/status` | cookie | état + appareil courant + csrf |
| GET | `/verify` | cookie | 204 + `X-Marex-Device`/`X-Marex-Trust-Until` (pour nginx/marexws) |
| POST | `/login` | — | maître (+TOTP) → appareil + cookie |
| POST | `/logout` | cookie + CSRF | révoque l'appareil courant |
| POST | `/step-up` | cookie + CSRF | maître (+TOTP) → jeton 5 min |
| GET | `/devices` | cookie | liste des appareils actifs |
| POST | `/devices/:id/revoke` | cookie + CSRF (+step-up si autre) | révoque |
| POST | `/devices/revoke-all` | cookie + CSRF + step-up | révoque tout |
| POST | `/ssh/ticket` | cookie + CSRF (+step-up si `sftp_root`) | ticket HMAC 60 s |
| POST | `/webauthn/register/options|verify` | cookie + CSRF | enrôlement passkey |
| POST | `/webauthn/login/options|verify` | — | connexion passkey → appareil |
| GET | `/webauthn/credentials` | cookie | liste des passkeys |
| POST | `/webauthn/credentials/:id/delete` | cookie + CSRF + step-up | suppression |

Erreurs : `401` verrouillé / mauvais mot de passe / mauvais TOTP, `403` CSRF/Origin/
step-up requis, `404` inconnu, `409` conflit, `429` rate limit (`retry_after`),
`503` maître non configuré.

## Connexion

### Maître
1. `POST /login {password, totp, trust_days}`.
2. Vérifie Argon2id (+TOTP si activé).
3. Crée un appareil, renvoie `device`, `trust_until`, `csrf` et le cookie
   `__Host-marexgate` (Secure, HttpOnly, SameSite=Strict).
4. `trust_days` = 0 → session 12 h ; sinon N jours (max 90).

### Passkey
1. `POST /webauthn/login/options` → challenge + `allowCredentials` (filtrés par RP/origine).
2. Le navigateur signe ; `POST /webauthn/login/verify`.
3. Vérifie l'origine/RP/challenge, met à jour le compteur, crée l'appareil (même TTL).
4. Repli maître toujours possible.

### Passkeys par domaine
RP/origine déterminés par le `Host` :
`marexcode.example.com` → `https://marexcode.example.com` ;
`neva.example-tailnet.ts.net` → `https://neva.example-tailnet.ts.net:8443`.
Un autre Host → `rp_not_allowed`. Enregistrer une passkey sur chaque domaine utilisé.

## Step-up

- `POST /step-up` (cookie + `X-CSRF` + `{password,totp}`) → `{token, expires_at}`.
- Jeton **en mémoire**, 5 min, lié à l'appareil.
- Requis pour : révoquer un **autre** appareil, tout révoquer, supprimer une passkey,
  obtenir un ticket `sftp_root`.
- L'UI ouvre le modal de confirmation ; annuler = pas d'action.

## Tickets SSH

`POST /ssh/ticket` (cookie + CSRF) :

```json
{"v":1,"sub":"<device>","exp":<+60s>,"nonce":"..."}
```

- Base64url(JSON) + "." + HMAC-SHA256(`proxy.key`).
- Usage unique (nonce mémorisé) ; 60 s.
- Avec `X-Step-Up` valide + `{sftp_root:true}` : ajoute `sftp_root:true` au payload.
- Vérifié par `marexssh` (PVE) avec la même clé.

## Alertes Telegram

- Fichier `/etc/marexcode/alerts.env` (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`).
- Envois : nouvel appareil, révocation, trop de tentatives de déverrouillage.
- Best-effort (timeout 5 s, pas de blocage du login).
- Supprimer le fichier → mode silencieux.

## Journaux / audit

- `audit.jsonl` (gate + marexws) : `login_success`, `login_failure`, `device_created`,
  `device_revoked`, `devices_revoked_all`, `step_up_success/failure`, `logout`,
  `ssh_ticket_issued`, `terminal_ws_open/closed`, `webauthn_*`, `panic`, `master_*`.
- Rotation : `/etc/logrotate.d/marexgate` (hebdo, 8, compress, copytruncate).
- `journalctl -u marexgate -f`.

## Sauvegarde / restauration de la DB

- **Cohérent** : `VACUUM INTO '/tmp/gate.db'` (Node `node:sqlite`) ou arrêter le
  service et copier `gate.db` + `-wal` + `-shm`.
- Le dépôt fournit un snapshot cohérent dans `ForkOffline/lxc102/gate.db`.
- Restaurer : arrêter `marexgate`, remplacer `gate.db`, `chown marexgate:marexgate`,
  `chmod 600`, démarrer. Les appareils/passkeys/maître sont conservés.

## Réinitialisations

- **Maître oublié** : `sudo marexgate reset` (révoque appareils + supprime passkeys)
  puis `sudo marexgate passwd`, puis ré-enrôler les passkeys.
- **Urgence (perte de contrôle)** : `sudo marexgate panic` + `sudo marexgate passwd`
  + `sudo systemctl stop marexssh` (coupe le SSH) ; éventuellement couper Serve.
- **Changer le maître** : `passwd` (garde les passkeys, révoque les sessions).

## Dépannage

| Symptôme | Cause / action |
|---|---|
| 503 `master_not_configured` | `sudo marexgate passwd` |
| 429 | rate limit app (10/10 min) ou nginx `gate` (5 r/s) ; attendre |
| 403 `bad_origin` | Origin inconnue (proxy/domaine non listé) |
| 403 `bad_csrf` | page périmée → recharger ; ou appel sans `X-CSRF` |
| 403 `step_up_required` | refaire le step-up (5 min) |
| Cookie absent | HTTPS obligatoire (`__Host-`), mauvais domaine (public vs ts.net) |
| Passkey refusée | RP/origine différent ; enregistrer sur ce domaine |
| Révocation lente | web 10 s (marexws), SSH 30 s (revalidation) |
| `marexgate: runuser not found` | ancien wrapper ; utiliser la version `setpriv` |
| DB corrompue | restaurer le snapshot cohérent (voir ci-dessus) |
| Appareils en trop | `marexgate devices` puis `revoke <id>` |
