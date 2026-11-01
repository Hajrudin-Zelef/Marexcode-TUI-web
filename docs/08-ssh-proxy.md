# 08 — SSH distant (`marexssh`, PVE)

## Ce que c'est

Un proxy **WebSocket → SSH** sur l'hôte PVE, accessible **uniquement via Tailscale**
(Serve `/ssh`). Il permet à la page Marexcode Web d'ouvrir un terminal SSH vers une
machine du tailnet ou des réseaux autorisés, avec authentification par mot de passe
ou clé privée, et un SFTP intégré (voir `09-sftp.md`).

## Emplacements

| Élément | Valeur |
|---|---|
| Code | `/opt/marexssh/server.js` (+ `package.json`, `package-lock.json`) |
| Runtime | `/opt/marexssh/bin/node` (Node 24.22.2 dédié) |
| Dépendances | `ssh2` ^1.16, `ws` ^8.18 (`npm ci`) |
| Utilisateur | `marexssh` (système, nologin) |
| Config | `/etc/marexssh/config.json` (0640 root:marexssh) |
| Clé HMAC | `/etc/marexssh/proxy.key` (0640 root:marexssh, identique à 102) |
| État | `/var/lib/marexssh/known_hosts.json`, `audit.jsonl` (0600 marexssh) |
| Service | `marexssh.service`, `127.0.0.1:8791` |
| CLI | `/usr/local/sbin/marexssh` (root) |
| Garde-fou | `marex-tailnet-guard.{service,timer}` (**désactivé le 2026-10-31**) |
| Exposition | `https://neva.example-tailnet.ts.net:8443/ssh` (Serve) |

## Installation (reconstruction)

```sh
# Node 24 dédié (pas de Node système)
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz
tar -xJf /tmp/node.tar.xz -C /opt/marexssh --strip-components=1
useradd --system --home /nonexistent --shell /usr/sbin/nologin marexssh
install -d -m 750 -o root -g marexssh /etc/marexssh
install -d -m 750 -o marexssh -g marexssh /var/lib/marexssh
# code + deps
cd /opt/marexssh && PATH=/opt/marexssh/bin:$PATH npm ci --omit=optional
# config + clé (copier les fichiers du bundle)
install -m 640 -o root -g marexssh host/neva/etc/marexssh/config.json /etc/marexssh/
install -m 640 -o root -g marexssh ForkOffline/neva/proxy.key /etc/marexssh/
# units + CLI
install -m 644 host/neva/etc/systemd/system/marexssh.service /etc/systemd/system/
install -m 750 host/neva/usr/local/sbin/marexssh /usr/local/sbin/
systemctl daemon-reload && systemctl enable --now marexssh
# exposition tailnet
tailscale serve --bg --https=8443 --set-path=/ssh http://127.0.0.1:8791
```

`tailscale serve status` doit montrer `/` → 105:80 et `/ssh` → 127.0.0.1:8791.

## Configuration (`config.json`)

```json
{
  "admins": ["<admin-tailscale>"],
  "allowed_cidrs": ["100.64.0.0/10", "10.0.0.0/24", "192.168.1.0/24"],
  "allowed_ports": [22, 2222],
  "idle_timeout_min": 15,
  "max_session_min": 480,
  "max_sessions": 3,
  "max_sessions_per_login": 6,
  "ticket_ttl_sec": 60,
  "ready_timeout_sec": 25,
  "sftp": { "max_bytes": 2147483648, "preview_bytes": 262144, "concurrent": 2, "max_entries": 2000 }
}
```

- `admins` : identités Tailscale autorisées (login exact, minuscules).
- Modifier puis `systemctl restart marexssh`.

## Authentification (triple)

1. **Identité Tailscale** : `Tailscale-User-Login` doit être dans `admins`.
   Serve injecte cet en-tête et **supprime** toute valeur client (anti-spoof).
2. **Ticket HMAC** délivré par le gate après déverrouillage maître
   (`POST /gate/ssh/ticket`, device + CSRF) : base64url(JSON) + "." + HMAC-SHA256
   (`proxy.key`), payload `{v:1, sub, exp:+60s, nonce}`, **usage unique**.
3. **Ticket `sftp_root`** (optionnel) : même ticket + `sftp_root:true`, émis seulement
   si `X-Step-Up` valide ; permet d'afficher `/` dans le SFTP.

## Politique réseau

- IPv4 uniquement ; toute IPv6 est refusée.
- Résolution DNS **une fois** ; **toutes** les adresses doivent être dans les CIDR
  autorisés ; connexion à l'IP résolue (anti-rebinding).
- Ports 22/2222 seulement.
- Refus : loopback, link-local, métadonnées, public, `0.0.0.0/8`, multicast.
- Limite : 3 sessions/appareil, 6/login ; idle 15 min ; max 480 min.

## Clés d'hôte (TOFU)

- Première connexion : empreinte SHA256 mémorisée dans `known_hosts.json` et affichée.
- Connexions suivantes : comparaison ; **clé changée = connexion bloquée** avec les
  deux empreintes.
- Vérifier hors bande puis :

```sh
sudo marexssh known-hosts
sudo marexssh forget 10.0.0.105:22   # redémarre marexssh (coupe les sessions)
sudo marexssh audit 50
sudo marexssh status
```

## Session et revalidation

- Après authentification, le proxy ouvre `client.shell()` (xterm-256color, taille
  transmise) et un canal SFTP sur la **même** connexion.
- **Revalidation** : toutes les 30 s, le cookie `__Host-marexgate` de la WS est envoyé
  à `http://10.0.0.102/_gate/verify-neva` (allow `10.0.0.1`). 401 → session coupée.
  Si le gate est injoignable, la session est **maintenue** (fail-open).
- Audit : `/var/lib/marexssh/audit.jsonl` (`ssh_ws_open`, `ssh_ticket_ok`,
  `ssh_connected`, `ssh_hostkey_new/mismatch`, `ssh_sftp_*`, `ssh_session_revoked`…).
- Aucun mot de passe/clé n'est journalisé ni stocké.

## UI (page → iframe)

- Bouton **SSH** dans le header.
- Sur le domaine **public** : message « SSH uniquement via Tailscale » + lien vers
  `https://neva.example-tailnet.ts.net:8443/`.
- Sur `ts.net` : iframe `/ssh-ui/` (xterm.js) ; le parent demande un ticket au gate
  (step-up pour la racine SFTP) et le transmet par `postMessage` (origine + source
  vérifiées).
- L'iframe ouvre `wss://<host>/ssh/ws` et gère le terminal + l'onglet Fichiers.

## Tests rapides

```sh
# santé
curl -s http://127.0.0.1:8791/health
# identité absente → 403 (WS)
# ticket invalide → bad_ticket
# destination publique → destination_denied ; port 80 → bad_port
# Serve : health via ts.net
curl -sk https://neva.example-tailnet.ts.net:8443/ssh/health
```

## Pièges

- **Ne pas exposer 8791** hors loopback : sinon l'en-tête d'identité est spoofable.
- La clé HMAC doit être **identique** sur 102 et PVE ; changer l'une impose de
  redémarrer `marexgate` **et** `marexssh`.
- `marexssh forget` redémarre le service (sessions coupées).
- `ts.net` n'est pas testable depuis 102 (102 n'atteint pas Serve).
- Un utilisateur local de PVE pourrait usurper `Tailscale-User-Login` sur
  `127.0.0.1`, mais il lui faudrait aussi un ticket HMAC valide (clé root/marexssh).
- Sans `tailscale serve`, l'UI SSH est inaccessible (message public ou erreur WS).
