# 15 — Secrets et identifiants

> **Les valeurs ne sont pas dans la documentation.** Elles vivent uniquement dans
> `ForkOffline/`, créé en `0700` et ignoré par git. Chiffre l'archive si elle sort
> du serveur (`age`, `gpg`).

## Où sont les secrets

### `ForkOffline/neva/`

| Fichier | Chemin réel | Contenu | Rotation |
|---|---|---|---|
| `proxy.key` | `/etc/marexssh/proxy.key` | clé HMAC (identique à 102) | même valeur sur 102 + restart marexgate/marexssh |

### `ForkOffline/lxc102/`

| Fichier | Chemin réel | Contenu | Rotation |
|---|---|---|---|
| `proxy.key` | `/etc/marexcode/proxy.key` | clé HMAC tickets SSH | même valeur sur PVE + restart |
| `alerts.env` | `/etc/marexcode/alerts.env` | token + chat Telegram | changer le token, restart marexgate |
| `gate.db` | `/var/lib/marexgate/gate.db` | hash maître Argon2id, secrets TOTP, jetons/hash des appareils, clés publiques passkeys | `marexgate passwd` / `reset` / `passkeys-clear` |
| `filebrowser.db` | `/home/sam/.filebrowser.db` | utilisateur `admin`, permissions, branding | reconfigurer MarexFile |

### `ForkOffline/lxc105/`

| Fichier | Chemin réel | Contenu | Rotation |
|---|---|---|---|
| `htpasswd` | `/etc/nginx/.htpasswd-marexcode` | Basic auth `marex` (hash apr1) | changer le mot de passe |
| `letsencrypt/` | `/etc/letsencrypt/` | certs, clés privées, compte ACME | certbot |

### Hors dépôt (non copiés)

| Fichier | Contenu | Raison |
|---|---|---|
| `/var/lib/tailscale/tailscaled.state` | clé du nœud + config Serve | réauthentifier |
| `/var/lib/marexssh/known_hosts.json` | empreintes d'hôtes SSH | se reconstruit (TOFU) |
| `/home/sam/.config/marex-code/.env` | clés API modèles (Marexcode CLI) | dans `/home/sam` (vzdump) |
| `/home/sam/litellm/.env` | clés providers + master key LiteLLM | dans `/home/sam` (vzdump) |
| `/home/sam/OpenDots/.env` | tokens OpenDots/Computer | dans `/home/sam` (vzdump) |
| `/home/sam/.ssh/*` | clés SSH de sam | dans `/home/sam` (vzdump) |
| `/usr/local/bin/*.sh` (PVE) | token Telegram des alertes PVE | dans l'hôte (backup PVE) |

## Bonnes pratiques

- `ForkOffline/` : `chmod 700`, fichiers en `600` — jamais versionné.
- Ne pas envoyer l'archive par chat/mail en clair.
- Après restauration : vérifier les modes (`stat -c '%a %U:%G %n'`).
- Le mot de passe maître n'est **jamais** stocké en clair (seulement son hash) ;
  en cas d'oubli : `marexgate reset`.
- Le token Telegram est partagé avec les autres alertes de l'hôte : le changer
  invalide les alertes de tous les scripts qui l'utilisent.

## Vérifier après restauration

```sh
stat -c '%a %U:%G %n' /etc/marexcode/proxy.key /etc/marexcode/alerts.env \
  /var/lib/marexgate/gate.db /etc/nginx/.htpasswd-marexcode \
  /etc/marexssh/proxy.key
```

Attendu : 640/600, jamais 644/666.

`scripts/restore-check.sh` contrôle l'intégrité des bases et la présence des clés.
