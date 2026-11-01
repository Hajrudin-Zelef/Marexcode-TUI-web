# 01 — Architecture

## Vue d'ensemble

```
                 Internet (clients)
                        │ 443/80
                        ▼
        ┌──────────────────────────────────────────┐
        │ PVE (hôte Proxmox, 192.168.1.75)       │
        │ nginx :443 = routeur SNI (stream)        │
        │  ├─ SNI marexcode/fichiers/stats... →    │
        │  │     10.0.0.105:443 (PROXY protocol) │
        │  └─ défaut → 10.0.0.105:443            │
        │ nginx :80 = autres sites (websearch...)  │
        │ tailscaled :8443 = Serve tailnet         │
        │  ├─ /    → 10.0.0.105:80               │
        │  └─ /ssh → 127.0.0.1:8791 (marexssh)     │
        └──────────────────────────────────────────┘
                 │ 10.0.0.0/24 (vmbr1)      │ loopback
                 ▼                            ▼
        ┌──────────────────────┐   ┌──────────────────────────┐
        │ LXC 105 webproxy     │   │ marexssh (hôte PVE)     │
        │ nginx 80/443         │   │ Node 24, 127.0.0.1:8791  │
        │ TLS + Basic auth     │   │ SSH/SFTP + WS            │
        │ rate limit + realip  │   └──────────────────────────┘
        │ page /var/www/...    │
        │ /gate /terminal /browser /metrics → 102
        └──────────────────────┘
                 │ 10.0.0.102:80 (allow 105 + host)
                 ▼
        ┌──────────────────────────────────────────────┐
        │ LXC 102 app-lxc                              │
        │ nginx :80 (marexcode / fichiers / stats)     │
        │  ├─ /terminal/N/ → marexws 769N → ttyd 768N  │
        │  ├─ /browser/    → File Browser 8082         │
        │  ├─ /gate/       → marexgate 8789            │
        │  ├─ /metrics/    → stats vhost → Netdata 19999
        │  └─ /_gate/verify (interne, auth_request)    │
        │ marexgate :8789 (Argon2id, passkeys, DB)     │
        │ ttyd 7681-7684 → tmux marex-1..4             │
        │ File Browser 8082 (read-only, /home/sam)     │
        │ Netdata 19999                                │
        └──────────────────────────────────────────────┘
```

## Composants

| Composant | Hôte | Rôle |
|---|---|---|
| `nginx` (routeur SNI) | PVE | lit le SNI TLS, envoie vers 105 avec PROXY protocol |
| `nginx` (105) | 105 | TLS, Basic auth, rate limit, CSP, vhosts, reverse proxy |
| Page `marexcode-web` | 105 | HTML/CSS/JS + iframe SSH (`ssh-ui/`) + xterm (`vendor/`) |
| `marexgate` | 102 | portail maître : Argon2id, TOTP, passkeys, appareils, step-up, tickets SSH |
| `marexws` | 102 | proxy WS gate-aware devant ttyd (révocation live 10 s) |
| `ttyd` + `tmux` | 102 | 4 terminaux indépendants (S1–S4) |
| File Browser | 102 | fichiers de `/home/sam` en lecture seule, monté sous `/browser/` |
| Netdata | 102 | métriques ; la page n'affiche qu'une ligne via `/metrics/` |
| `marexssh` | PVE | proxy SSH + SFTP (Tailscale Serve `/ssh`, ticket HMAC) |
| `fail2ban` | 105 (+ PVE) | bans sur 401 Basic / 401 portail |
| `certbot` | 105 | certificats Let's Encrypt |
| Tailscale Serve | PVE | `/` → page, `/ssh` → marexssh ; identité admin |

## Flux principaux

### 1. Ouvrir la page
1. Le client résout `marexcode.example.com` → `203.0.113.10`.
2. PVE stream lit le SNI, transmet à `10.0.0.105:443` avec PROXY.
3. 105 termine TLS, applique `real_ip` (IP client réelle), demande le Basic auth
   (`marex`), puis sert `/var/www/marexcode-web/index.html` avec CSP + en-têtes.
4. La page charge `/browser/` (iframe), `/terminal/N/` (à la demande), `/metrics/`
   (poll 3 s). Tous ces chemins repassent par 105 → 102.

### 2. Déverrouiller (portail)
1. `/gate/status` indique verrouillé.
2. L'utilisateur saisit le mot de passe maître (ou une passkey).
3. `POST /gate/login` vérifie Argon2id (+ TOTP si activé) → crée un **appareil**
   et un cookie `__Host-marexgate` (Secure/HttpOnly/SameSite=Strict), TTL 30 j
   par défaut (0 = session 12 h).
4. La page recharge les panneaux ; nginx `auth_request` vérifie le cookie à
   chaque requête `/terminal/` et `/browser/`.

### 3. Terminal web
1. La page charge `/terminal/N/` (iframe). 105 → 102 nginx → `marexws` 769N.
2. `marexws` valide le cookie via le gate, puis relaie HTTP/WS vers ttyd 768N.
3. ttyd attache la session tmux `marex-N` (créée au premier accès).
4. Toutes les 10 s, `marexws` revalide le cookie ; révocation/expiration →
   fermeture WS (code 1008), tmux garde la session.

### 4. SSH distant
1. La page (uniquement sur `ts.net`) demande un ticket au gate
   (`POST /gate/ssh/ticket`, device + CSRF).
2. L'iframe `/ssh-ui/` ouvre `wss://neva.example-tailnet.ts.net:8443/ssh/ws`
   (Tailscale Serve), envoie le ticket puis les identifiants SSH.
3. `marexssh` vérifie : identité `Tailscale-User-Login` = admin, ticket HMAC
   (60 s, usage unique), destination dans les CIDR autorisés, port 22/2222,
   clé d'hôte épinglée, puis ouvre le shell.
4. Revalidation du device via `/_gate/verify-neva` toutes les 30 s.

### 5. SFTP
1. Une fois le shell ouvert, `marexssh` ouvre un canal SFTP et renvoie un
   **jeton de session**.
2. Les opérations passent par la WS (liste, mkdir, rename, copy) et par des
   endpoints HTTP (`/ssh/sftp/upload|download|preview`) authentifiés par ce jeton.
3. La racine est le home ; `/` nécessite un ticket `sftp_root` (step-up maître).

## Ports

| Où | Port | Quoi | Exposition |
|---|---|---|---|
| PVE | 22 | sshd admin | LAN/tailnet (firewall PVE) |
| PVE | 80/443 | nginx (routeur + sites) | Internet |
| PVE | 8443 | Tailscale Serve | tailnet uniquement |
| PVE | 8791 | marexssh | loopback |
| 105 | 22 | sshd | LAN |
| 105 | 80/443 | nginx | depuis PVE seulement |
| 102 | 22 | sshd (admin host) | LAN + tailnet (garde-fou désactivé) |
| 102 | 80 | nginx | 105 + hôte uniquement |
| 102 | 7681–7684 | ttyd | loopback |
| 102 | 7691–7694 | marexws | loopback |
| 102 | 8082 | File Browser | loopback |
| 102 | 8789 | marexgate | loopback |
| 102 | 19999 | Netdata | loopback |

## Domaines / DNS / TLS

- `marexcode.example.com` → `203.0.113.10` (A), cert Let's Encrypt.
- `fichiers.example.com` → même IP, redirige 301 vers la page (cert conservé).
- `stats.example.com` → Netdata direct (cert conservé, accès Basic auth).
- `neva.example-tailnet.ts.net:8443` → Tailscale Serve (cert Tailscale), tailnet only.
- Certificats valides jusqu'au **2027-01-28** (vérifier avec `certbot certificates`).

## Versions au moment du bundle (2026-10-31)

- nginx 1.26.3 (PVE, 102, 105), Tailscale 1.102.4, Proxmox VE 7.0.14.
- Node 24.21.0 (102, gate/ws), Node 24.22.2 dédié (`/opt/marexssh`).
- Bun 1.4.4 (Marexcode CLI), ttyd 1.7.7, File Browser 2.63.23, Netdata 2.12.2.
- certbot 4.0.0, Fail2Ban 1.1.0, `@node-rs/argon2` 2.2.2, `@simplewebauthn/server` 14.0.3,
  `ssh2` ^1.16, `ws` ^8.18.

## Frontières de confiance

- **Internet → 105** : seul 105 est exposé ; Basic auth + TLS + rate limit.
- **105 → 102** : réseau interne ; 102 n'accepte que 105 et l'hôte.
- **PVE → 102** : uniquement `/_gate/verify-neva` (allow `10.0.0.1`).
- **Tailnet → marexssh** : identité Serve + ticket HMAC + allowlist destinations.
- **JAMAIS exposé** : gate, ttyd, marexws, File Browser, Netdata, marexssh.

## Mise à jour 2026-10-31 — interface premium → MarexFile

- **Page** : design premium (dark, accents), 6 thèmes, volet **Monaco** (éditeur VS Code,
  vendorisé), **responsive mobile** (menu ⋯, overlays, visualViewport), barre de
  monitoring une ligne.
- **MarexFile** : File Browser renommé, monogramme MF, favicons, liens externes masqués.
- **Séparateurs** redimensionnables entre Fichiers | Terminal | Monaco (largeurs
  persistées).
- **Performance** : `/browser/static/` servi sans gate, cache immutable + gzip,
  keepalive ; CSS 67 → 22 Ko ; voir `21-performance.md`.
- **Thème SSH** : la page injecte le thème courant dans l'iframe `/ssh-ui/`
  (`22-ssh-theme.md`).
- La chaîne réseau reste identique : PVE (SNI+PROXY) → 105 → 102 → services loopback.
