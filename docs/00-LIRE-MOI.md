# Marexcode Web — documentation complète

Ce dépôt contient l'application **et** son infrastructure, avec la documentation
nécessaire pour la comprendre, la déployer et la restaurer sans dépendre de la
mémoire d'un agent.

> **État** : design premium, 6 thèmes, panneau **Réglages**, volet **Monaco**,
> responsive mobile avec **barre de touches** et clavier code, MarexFile (ex-File
> Browser), SSH/SFTP sous Tailscale, et optimisations de cache/gzip.

## Par où commencer

| Si tu veux… | Lis… |
|---|---|
| Comprendre le système en 5 minutes | `01-architecture.md` |
| Savoir où est chaque fichier | `02-inventaire.md` |
| Comprendre l'authentification | `03-securite.md` |
| Modifier nginx, le domaine, TLS, Tailscale | `04-nginx-reseau.md` |
| Gérer le mot de passe maître, les appareils, les passkeys | `05-gate.md` |
| Comprendre les terminaux S1–S4 | `06-terminal-ttyd.md` |
| Comprendre MarexFile et le monitoring | `07-marexfile-netdata.md` |
| Comprendre le SSH distant | `08-ssh-proxy.md` |
| Comprendre le SFTP | `09-sftp.md` |
| Déployer une modification | `10-deploiement.md` |
| Faire une opération de maintenance | `11-runbooks.md` |
| Sauvegarder / restaurer | `12-sauvegarde-restauration.md` |
| Réparer une panne | `13-depannage.md` |
| Voir ce qui a été testé | `14-validation.md` |
| Connaître les secrets et où ils sont | `15-secrets.md` |
| Voir l'historique | `16-changelog.md` |
| Réinstaller les dépendances | `17-dependances.md` |
| Changer les couleurs / thèmes | `18-themes.md` |
| Modifier le volet Monaco | `19-monaco.md` |
| Comprendre le responsive mobile | `20-responsive.md` |
| Comprendre les optimisations MarexFile | `21-performance.md` |
| Comprendre le thème du panneau SSH | `22-ssh-theme.md` |
| Configurer l'interface (Réglages) | `23-settings.md` |
| Animations, flou, effets premium | `24-premium-effects.md` |
| Barre de touches mobile + clavier code | `25-mobile-keyboard.md` |
| Installer sur un autre serveur / VPS | `26-installer-ailleurs.md` |

## L'essentiel en 10 lignes

- **URL principale** : `https://marexcode.example.com` (auth Basic `marex` + portail maître).
- **Fallback Tailscale** : `https://neva.example-tailnet.ts.net:8443` (page + SSH).
- **Page** : LXC **105**, `/var/www/marexcode-web/` (source : `app/`).
- **Portail / gate** : LXC **102**, `marexgate` sur `127.0.0.1:8789`.
- **Terminaux** : LXC 102, ttyd `7681–7684` → tmux `marex-1..4`, relayés par `marexws` `7691–7694`.
- **MarexFile** : LXC 102, `/home/sam`, servi sous `/browser/` (lecture seule, branding MF).
- **Monitoring** : LXC 102, Netdata `127.0.0.1:19999`, API via `/metrics/`.
- **SSH/SFTP** : hôte **PVE**, `marexssh` `127.0.0.1:8791`, exposé par Tailscale Serve sous `/ssh`.
- **Routeur public** : PVE nginx `443` (SNI + PROXY) → 105 `443` → 102 `80`.
- **Sauvegardes** : `vzdump` quotidien des LXC à 21:00 (keep 3) dans `/mnt/backup`.

## Structure du dépôt

```
marexcode-web/
├── README.md
├── .gitignore              ForkOffline/ et deps/ exclus
├── app/                    sources de l'interface
│   ├── index.html
│   ├── ssh-ui/
│   └── vendor/             xterm + monaco
├── host/
│   ├── neva/               marexssh, units, routeur nginx
│   ├── lxc102/             marexgate, marexws, ttyd/tmux, nginx, branding
│   └── lxc105/             page déployée, nginx, fail2ban, scripts CSP
├── docs/                   ces documents (00 → 25)
├── reference/              plans + specs Operator
├── scripts/                installation, déploiement, vérification, sauvegarde
├── deps/                   binaires (hors git)
└── ForkOffline/            secrets et bases (hors git, 0700)
```

## Avertissement sécurité

Les secrets ne sont **pas** dans ce dépôt : ils sont dans `ForkOffline/`
(clé HMAC, token Telegram, hash du mot de passe maître et appareils dans `gate.db`,
`.htpasswd`, clés privées TLS). Voir `15-secrets.md`. Ce dossier doit rester en
`0700` et être chiffré avant tout stockage hors-site.

## Dépendances

Les binaires sont dans `deps/` (hors git) : Node 24 (102 et PVE), Bun, ttyd,
File Browser/MarexFile, Netdata, `node_modules` de `marexgate` et `marexssh`.
Les versions, URLs et procédures de réinstallation sont dans `17-dependances.md`.

## Ce qui n'est PAS dans le dépôt

- `/home/sam` complet sur 102 (~23 Go) et les volumes Docker : couverts par `vzdump`.
- L'état Tailscale (`tailscaled.state`) : à réauthentifier.
- Les sauvegardes `vzdump`, les modèles LLM, les logs.
- Les certificats sont dans `ForkOffline/lxc105/letsencrypt/` (ou réémissibles).

## Restauration rapide

1. **Tout le LXC** : `pct restore 999 /mnt/backup/dump/vzdump-lxc-102-....tar.zst --storage local-lvm`
   (voir `12-sauvegarde-restauration.md` ; ne jamais écraser 102 sans sauvegarde).
2. **Config web** : `scripts/deploy-102.sh` et `scripts/deploy-105.sh` (ou copie
   manuelle depuis `host/lxc102` et `host/lxc105`), puis `nginx -t` et redémarrage.
3. **Portail** : restaurer `ForkOffline/lxc102/gate.db` vers `/var/lib/marexgate/gate.db`,
   remettre les unités, redémarrer `marexgate`.
4. **MarexFile** : `host/lxc102/opt/marexfile-branding` → `/opt/marexfile-branding`,
   base `ForkOffline/lxc102/filebrowser.db` → `/home/sam/.filebrowser.db`.
5. **SSH** : `scripts/install-neva.sh` puis `scripts/deploy-neva.sh`, puis
   `tailscale serve --https=8443 --set-path=/ssh http://127.0.0.1:8791`.
6. **Page** : `scripts/deploy-105.sh` (copie `app/` → `/var/www/marexcode-web/`),
   puis `/usr/local/sbin/marexcode-web-deploy` (régénère la CSP).

En cas de doute : `13-depannage.md` contient les symptômes → causes → correctifs.
