# Marexcode Web

Application web d'accès à Marexcode : page unique, terminaux tmux dans le
navigateur, explorateur de fichiers (MarexFile), éditeur Monaco, SSH/SFTP sous
Tailscale, monitoring, thèmes et interface mobile.

## Carte du dépôt

```
app/          sources de l'interface (page, ssh-ui, vendor Monaco)
host/neva/    proxy SSH (marexssh), routeur nginx SNI, units systemd
host/lxc102/  portail (marexgate), proxy WebSocket (marexws), ttyd/tmux,
              MarexFile, nginx local, branding
host/lxc105/  page déployée, nginx public/TLS, fail2ban, scripts CSP
docs/         documentation complète (26 documents)
reference/    plans de sécurité et specs
scripts/      installation, déploiement, vérification, sauvegarde
ForkOffline/  secrets et bases (ignoré par git)
prive/        version réelle de l'infra (ignoré par git)
deps/         binaires (ignoré par git)
```

## Déploiement

| Machine | Script | Rôle |
|---|---|---|
| PVE (hôte) | `scripts/deploy-neva.sh` | marexssh, units, routeur nginx |
| LXC 102 | `scripts/deploy-102.sh` | gate, marexws, ttyd/tmux, MarexFile |
| LXC 105 | `scripts/deploy-105.sh` | page, nginx, fail2ban, CSP |
| — | `scripts/deploy-all.sh` | orchestre les trois (depuis PVE) |
| — | `scripts/verify.sh` | contrôle services, ports, URLs |

Chaque script admet `--dry-run`.

## Version partageable

La racine du dépôt utilise des valeurs d'exemple (`example.com`, `10.0.0.x`).
La version réelle est dans `prive/` (ignoré par git).
Voir `docs/26-installer-ailleurs.md`.

## Secrets

`ForkOffline/` contient les secrets (clés HMAC, `gate.db`, `.filebrowser.db`,
certs TLS, `.htpasswd`, `alerts.env`). Il est ignoré par git et doit rester en
0600. Voir `docs/15-secrets.md` et `docs/22-secrets.md`.

## Documentation

Commencer par `docs/00-LIRE-MOI.md`, puis `docs/01-architecture.md`.
`docs/19-depannage.md` couvre les incidents déjà rencontrés.

## Prérequis

- PVE : nginx (stream + PROXY), Tailscale, Node 24 dédié dans `/opt/marexssh`.
- 102 : Node 24, ttyd, tmux, FileBrowser, Netdata, nginx.
- 105 : nginx, certbot, fail2ban.
- GitHub : dépôt privé, clé de déploiement en écriture pour pousser depuis 102.

Les versions exactes et les URLs de téléchargement sont dans
`docs/17-dependances.md`.
