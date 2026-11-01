# Marexcode Web — documentation complète (bundle du 2026-10-31)

Ce dossier contient **tout ce qu'il faut savoir et tout ce qu'il faut pour restaurer**
Marexcode Web, sans dépendre de la mémoire d'un agent.

> **Mise à jour majeure** : depuis la première version du bundle, l'interface a reçu
> le design **premium**, 6 **thèmes**, un volet **Monaco**, le **responsive mobile**,
> le renommage **MarexFile** (avec monogramme MF) et des **optimisations** de cache,
> gzip et gate pour File Browser. Le panneau **SSH suit aussi le thème**.
> Un panneau **Réglages** (engrenage) centralise thèmes, Monaco, terminal,
> monitoring, fichiers et sécurité.

## Par où commencer

| Si tu veux… | Lis… |
|---|---|
| Comprendre le système en 5 minutes | `01-architecture.md` |
| Savoir où sont les fichiers sur chaque machine | `02-inventaire.md` |
| Comprendre l'authentification et les protections | `03-securite.md` |
| Modifier/dépanner nginx, le domaine, TLS, Tailscale | `04-nginx-reseau.md` |
| Gérer le mot de passe maître, les appareils, les passkeys | `05-gate.md` |
| Comprendre les terminaux S1–S4 | `06-terminal-ttyd.md` |
| Comprendre MarexFile (ex-File Browser) et le monitoring | `07-marexfile-netdata.md` |
| Comprendre le SSH distant | `08-ssh-proxy.md` |
| Comprendre le SFTP | `09-sftp.md` |
| Déployer une modification de la page | `10-deploiement.md` |
| Faire une opération de maintenance | `11-runbooks.md` |
| Sauvegarder / restaurer | `12-sauvegarde-restauration.md` |
| Réparer une panne | `13-depannage.md` |
| Voir ce qui a été testé | `14-validation.md` |
| Connaître les secrets et où ils sont | `15-secrets.md` |
| Voir l'historique | `16-changelog.md` |
| Réinstaller les dépendances | `17-dependances.md` |
| Changer les couleurs / comprendre les thèmes | `18-themes.md` |
| Modifier le volet Monaco | `19-monaco.md` |
| Comprendre le responsive mobile | `20-responsive.md` |
| Comprendre les optimisations File Browser | `21-performance.md` |
| Comprendre le thème du panneau SSH | `22-ssh-theme.md` |
| Configurer l'interface (Réglages) | `23-settings.md` |
| Animations, flou, effets premium | `24-premium-effects.md` |
| Barre de touches mobile + clavier code | `25-mobile-keyboard.md` |

## L'essentiel en 10 lignes

- **URL principale** : `https://marexcode.example.com` (auth Basic `marex` + portail maître).
- **Fallback Tailscale** : `https://neva.example-tailnet.ts.net:8443` (page + SSH).
- **Page** (couche premium incluse) : LXC **105**, `/var/www/marexcode-web/` (source PVE : `/home/sam/marexcode-web-index.html`).
- **Portail / gate** : LXC **102**, `marexgate` sur `127.0.0.1:8789`.
- **Terminaux** : LXC 102, ttyd `7681–7684` → tmux `marex-1..4`, exposés par `marexws` `7691–7694`.
- **MarexFile** : LXC 102, `/home/sam`, servi sous `/browser/` (lecture seule, branding MF).
- **Monitoring** : LXC 102, Netdata `127.0.0.1:19999`, API via `/metrics/`.
- **SSH/SFTP** : hôte **PVE**, `marexssh` `127.0.0.1:8791`, exposé par Tailscale Serve sous `/ssh`.
- **Routeur public** : PVE nginx `443` (SNI + PROXY) → 105 `443` → 102 `80`.
- **Sauvegardes** : `vzdump` quotidien de tous les LXC à 21:00 (keep 3) dans `/mnt/backup`
  + backup config PVE à 03:00. **Pas de hors-site actuellement.**

## Structure du bundle

```
marex-web/
├── README.md                 ← ce fichier (vue d'ensemble + restauration rapide)
├── MANIFEST.sha256           ← empreintes SHA-256 de tous les fichiers
├── docs/marex-web/           ← la documentation (00 → 22)
├── reference/                ← plan de sécurisation, plan MarexFile, specs Operator
└── files/
    ├── neva/                 ← configs et code de l'hôte PVE (+ sources de la page)
    ├── lxc102/               ← gate, ws, ttyd, MarexFile, branding, Node/Bun/Netdata
    ├── lxc105/               ← page, nginx, certs, fail2ban, vendor Monaco
    └── backups/              ← anciens .bak de phase (historique)
```

## Avertissement sécurité

Ce bundle contient des **secrets** : clé HMAC, token Telegram, hash du mot de passe
maître et jetons d'appareils (`gate.db`), `.htpasswd`, clés privées TLS et compte ACME.
Il est créé en `0600`. **Chiffre-le avant tout stockage hors-site** (ex. `age`, `gpg`,
ou archive chiffrée), et ne le laisse pas traîner en clair.

## Dépendances incluses

`node_modules` de `marexgate` et `marexssh`, Node 24 (102 et PVE), Bun,
MarexFile (ex-File Browser), ttyd, Netdata (binaire, libs, état, unité),
les vendors de la page (**xterm** et **Monaco**), et le dossier de branding
`/opt/marexfile-branding`. Voir `17-dependances.md`.

## Ce qui n'est PAS dans ce bundle

- L'état Tailscale (`/var/lib/tailscale/tailscaled.state`, clé du nœud) : à réauthentifier.
- Le contenu complet de `/home/sam` sur 102 et les volumes Docker : couvert par le `vzdump` LXC.
- Les logs (non essentiels).
- Les certificats sont inclus, mais tu peux aussi les réémettre avec certbot.

## Restauration rapide

1. **Tout le LXC** : `pct restore 999 /mnt/backup/dump/vzdump-lxc-102-....tar.zst --storage local-lvm`
   (voir `12-sauvegarde-restauration.md`, ne jamais écraser 102 sans sauvegarde).
2. **Juste la config web** : recopier `files/lxc102` et `files/lxc105` aux bons chemins,
   `nginx -t`, redémarrer les services.
3. **Juste le portail** : restaurer `var/lib/marexgate/gate.db` (snapshot cohérent fourni),
   remettre les unités, redémarrer `marexgate`.
4. **MarexFile** : remettre `/opt/marexfile-branding`, `--branding.*` dans la base
   `.filebrowser.db` (déjà fournie), service `filebrowser-marexcode`.
5. **SSH** : Node 24 + `npm ci`, `config.json` + `proxy.key`, unités, puis
   `tailscale serve --https=8443 --set-path=/ssh http://127.0.0.1:8791`.
6. **Page** : `files/neva/home/sam/marexcode-web-index.html` → 105 ;
   `marexcode-web-ssh-ui/` et `marexcode-web-vendor/` → 105 ; puis
   `/usr/local/sbin/marexcode-web-deploy` (CSP).

En cas de doute : `13-depannage.md` contient les symptômes → causes → correctifs.
