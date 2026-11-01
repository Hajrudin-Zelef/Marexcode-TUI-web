# 26 — Version partageable et installation ailleurs (VPS)

## Deux versions du projet

| Où | Contenu | Versionné |
|---|---|---|
| `prive/` | ta version **réelle** : vrais domaines, IPs, utilisateurs, chemins, profils de déploiement | **non** (`.gitignore`) |
| racine du dépôt | version **partageable** : mêmes fichiers, valeurs d'exemple (`example.com`, `10.0.0.x`) | oui |

`prive/` est une copie complète (121 fichiers, ~14 Mo) qui pointe vers les secrets
réels via un lien `prive/ForkOffline → ../ForkOffline`. C'est elle qui sert au
déploiement sur ton infrastructure.

La racine est ce qui peut être publié : aucune valeur d'infrastructure réelle.

## Tableau des valeurs d'exemple

| Élément | Valeur dans le dépôt | À remplacer par |
|---|---|---|
| Domaine principal | `marexcode.example.com` | ton domaine |
| Domaines secondaires | `fichiers.example.com`, `stats.example.com` | tes sous-domaines |
| Tailnet | `neva.example-tailnet.ts.net` | ton nom MagicDNS |
| Hôte Proxmox | `PVE` | ton hôte |
| LXC application | `app-lxc` | ton conteneur/serveur |
| LXC web | `web-lxc` | ton conteneur/serveur |
| Réseau app | `10.0.0.0/24` | ton sous-réseau |
| Réseau admin | `10.0.1.0/24` | ton sous-réseau |
| Réseau secondaire | `10.0.2.0/24` | ton sous-réseau |
| Réseau LAN | `192.168.1.0/24` | ton LAN |
| IP publique | `203.0.113.10` | ton IP |
| Admin Tailscale | `admin@example.com` | ton compte |
| Utilisateur Linux | `sam` | ton utilisateur |
| Racine web | `/home/sam` | ton chemin |

## Installer sur un VPS (sans Proxmox)

Sur un VPS unique, les trois rôles (routeur, application, web) peuvent cohabiter.

1. **Système** : Debian 13, `nginx`, `tmux`, `certbot`, `fail2ban`, `openssl`,
   Node 24 dans `/opt/marexssh` (voir `17-dependances.md`).
2. **Cloner et adapter** :
   ```sh
   git clone <dépôt> marexcode-web && cd marexcode-web
   # remplacer les valeurs d'exemple par les tiennes
   grep -rl "example.com" host app scripts | xargs sed -i 's/example\.com/ton-domaine.tld/g'
   ```
3. **Déployer** : `scripts/install-*` puis `scripts/deploy-*`.
   Sur un seul serveur, `deploy-*.sh` s'exécutent localement (pas de `pct`).
4. **TLS** : `certbot --nginx -d ton-domaine.tld` puis ajuster les chemins de
   certificats dans `host/lxc105/nginx/sites-available/marexcode.conf`.
5. **Tailscale (optionnel)** : si tu veux le SSH/SFTP, installer Tailscale,
   publier `tailscale serve --bg --https=8443 --set-path=/ssh http://127.0.0.1:8791`
   et renseigner ton login admin dans `host/neva/etc/marexssh/config.json`.
6. **Sans Tailscale** : le panneau SSH restera indisponible (message sur le domaine
   public) ; le reste (page, terminaux, MarexFile, Monaco, monitoring) fonctionne.
7. **Adapter les chemins** : les units systemd et `scripts/*` utilisent
   `/home/sam` et `/opt/...` ; modifier si l'utilisateur ou l'arborescence diffèrent.

## Ce qui est spécifique à Proxmox

- L hôte Proxmox (rôle `PVE` dans le dépôt) porte le nginx stream (SNI + PROXY protocol).
- Les scripts `deploy-all.sh` utilisent `pct` ; sur un VPS, appeler directement
  `deploy-102.sh` / `deploy-105.sh` sur la machine.
- Le `vzdump` n'existe pas sur un VPS : utiliser le script `backup-now.sh`
  (archives locales) et une sauvegarde externe.

## Règle de travail

1. Modifier la version **réelle** dans `prive/`.
2. Déployer depuis `prive/`.
3. Pour publier : reporter les changements de code dans la racine, **sans** les
   valeurs d'infrastructure, puis vérifier :
   ```sh
   grep -RE "neva-ci\.pro|10\.10\.|192\.168\.|160\.120\.|tailf[0-9]" .
   ```
   doit ne rien retourner (hors `prive/`).
