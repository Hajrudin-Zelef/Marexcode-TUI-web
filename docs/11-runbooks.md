# 11 — Runbooks (maintenance)

Commandes `marexgate` : root sur **102**. `marexssh` : root sur **PVE**.
`pct` : root sur **PVE**.

## 1. Vérifier que tout va bien (2 minutes)

```sh
# 102
pct exec 102 -- sh -c 'systemctl is-active marexgate marexws nginx filebrowser-marexcode netdata "ttyd-marexcode@1"; curl -s 127.0.0.1:8789/health'
# 105
pct exec 105 -- sh -c 'systemctl is-active nginx fail2ban; nginx -t'
# PVE
systemctl is-active marexssh tailscaled nginx
curl -s 127.0.0.1:8791/health
tailscale serve status
iptables -C FORWARD -i tailscale0 -d 10.0.0.102/32 -p tcp --dport 22 -j DROP && echo guard_ok
# public
curl -sk -o /dev/null -w '%{http_code}\n' https://marexcode.example.com/   # 401
```

## 2. Portail / mot de passe maître

| Besoin | Commande |
|---|---|
| Changer le maître | `sudo marexgate passwd` (garde les passkeys, révoque les sessions) |
| Maître oublié | `sudo marexgate reset` puis `sudo marexgate passwd` (supprime aussi les passkeys) |
| Ajouter/retirer TOTP | `sudo marexgate totp-setup` / `totp-disable` |
| Voir l'état | `sudo marexgate status` |

## 3. Appareils

```sh
sudo marexgate devices
sudo marexgate revoke <id>
sudo marexgate revoke all
```
Effet : terminaux web ≤ ~10 s, SSH/SFTP ≤ ~30 s. Audits :
`terminal_ws_closed`, `ssh_session_revoked`.

## 4. Passkeys

```sh
sudo marexgate passkeys
sudo marexgate passkeys-clear     # tout supprimer
# suppression unitaire : UI « Appareils » (step-up)
```
Une passkey perdue n'est pas bloquante : le maître reste le repli. Si plus d'accès :
`reset` puis ré-enrôlement. Une passkey est liée à son domaine (public vs ts.net).

## 5. Urgence (panic)

```sh
sudo marexgate panic            # révoque tous les appareils + supprime les passkeys
sudo marexgate passwd           # nouveau maître
sudo systemctl stop marexssh    # coupe les sessions SSH en cours
sudo tailscale serve --https=8443 --set-path=/ssh off
# vérifier
sudo marexgate status; tailscale serve status; sudo marexssh audit 20
```
Pour tout rouvrir : `tailscale serve --bg --https=8443 --set-path=/ssh http://127.0.0.1:8791`
et `systemctl start marexssh`.

## 6. Clé d'hôte SSH changée

```sh
sudo marexssh known-hosts
sudo marexssh forget 10.0.0.105:22     # après vérification hors bande
sudo marexssh audit 50
```
`forget` redémarre `marexssh` (sessions coupées). Un changement inexpliqué = alerte
(MITM/rebuild) : ne pas oublier sans vérifier.

## 7. Certificats

```sh
pct exec 105 -- certbot certificates
pct exec 105 -- certbot renew --dry-run
pct exec 105 -- certbot certonly --webroot -w /var/www/certbot -d <domaine>
```
Puis recharger nginx 105. Vérifier les dates (`openssl x509 -enddate`).

## 8. Fail2ban

```sh
pct exec 105 -- fail2ban-client status
pct exec 105 -- fail2ban-client status nginx-ttyd
pct exec 105 -- fail2ban-client status nginx-marexgate
pct exec 105 -- fail2ban-client set nginx-ttyd unbanip <ip>
```
ignoreip : `/etc/fail2ban/jail.d/nginx-ttyd.local` et `nginx-marexgate.local`
(loopback, IP publique, 10.0.0.0/24, 10.0.1.0/24, 192.168.1.0/24).
Ne jamais bannir 10.0.0.102 (proxy interne) : il est dans ignoreip.

## 9. Journaux / audit

```sh
sudo marexgate status
pct exec 102 -- tail -f /var/lib/marexgate/audit.jsonl
sudo marexssh audit 100
pct exec 105 -- tail -f /var/log/nginx/marexcode.access.log
journalctl -u marexgate -f
journalctl -u marexws -f
journalctl -u marexssh -f
```
Rotation : `/etc/logrotate.d/marexgate` (hebdo, 8, compress).

## 10. Sessions tmux

```sh
su - sam -c 'tmux ls'
su - sam -c 'tmux kill-session -t marex-2'
systemctl restart 'ttyd-marexcode@2'
```
Ne pas tuer la session historique `marexcode` (opencode).

## 11. Disque / espace

```sh
df -h / /mnt/backup /mnt/data
du -sh /mnt/backup/dump
# 102
pct exec 102 -- df -h /
```
Si `/mnt/backup` approche 90 % : déplacer/débloquer les archives ou utiliser
`/mnt/data` (496 Go libres) — voir `12-sauvegarde-restauration.md`.

## 12. Rotation de la clé HMAC SSH

```sh
# PVE + 102 : même secret
openssl rand -hex 32 > /tmp/proxy.key
install -m 640 -o root -g marexgate /tmp/proxy.key /etc/marexcode/proxy.key    # 102
install -m 640 -o root -g marexssh  /tmp/proxy.key /etc/marexssh/proxy.key     # PVE
rm -f /tmp/proxy.key
systemctl restart marexgate      # 102
systemctl restart marexssh       # PVE
```

## 13. Ajouter un admin Tailscale SSH

```sh
# éditer /etc/marexssh/config.json → "admins": [..., "login@example.com"]
systemctl restart marexssh
```

## 14. Tailscale

```sh
tailscale status
tailscale serve status
tailscale serve --bg --https=8443 --set-path=/ssh http://127.0.0.1:8791
tailscale serve --https=8443 --set-path=/ssh off
```
- Serve `/` → 105:80, `/ssh` → 8791.
- ACL (admin console) : restreindre l'accès ; le garde-fou iptables 102:22 est **désactivé** depuis le 2026-10-31.
- L'état du nœud n'est pas dans le bundle : réauthentifier après réinstallation.

## 15. Redéployer la page

Voir `10-deploiement.md` : push + `marexcode-web-deploy` (CSP) **obligatoire**.

## 16. Incidents fréquents — premiers réflexes

| Symptôme | Premier réflexe |
|---|---|
| Page 502/503 | `pct exec 102 -- systemctl is-active nginx marexgate` ; logs nginx 105 |
| 401 en boucle | Basic auth (`curl -u`) ; fail2ban a-t-il banni ton IP ? |
| Page blanche / verrou figé | CSP non régénérée → `marexcode-web-deploy` |
| Terminal « Reconnecting » | `marexws`/ttyd ; cookie expiré ; host key ? |
| Fichiers 401 dans l'iframe | URL cross-origin ; utiliser `/browser/` |
| Métriques vides | Netdata 19999 / `/metrics/` ; `_gate` cookie |
| SSH impossible | Tailscale actif ? identité admin ? ticket/step-up ? host key ? |
| « destination non autorisée » | CIDR/port hors liste |
| SFTP `outside_root` | symlink/chemin hors home ; racine = step-up |
| `gate` 503 | maître non configuré → `passwd` |
| `gate` 429 | rate limit app/nginx ; attendre |
| Cert expiré | `certbot renew` + reload 105 |
| Disque plein | `/mnt/backup` 75 % ; déplacer vers `/mnt/data` |

Détail des causes/correctifs : `13-depannage.md`.

## Runbooks MarexFile / thèmes / perf (2026-10-31)

### Changer le nom ou le logo MarexFile
```sh
# logo : /opt/marexfile-branding/img/... ; custom.css pour l'en-tête étroit
systemctl stop filebrowser-marexcode       # 2 s
filebrowser -d /home/sam/.filebrowser.db config set --branding.name "MarexFile"   --branding.files /opt/marexfile-branding --branding.disableExternal
systemctl start filebrowser-marexcode
```

### Changer un thème
1. Éditer `index.html` (variables du bloc `html[data-theme=...]`).
2. `pct push 105 …` puis `/usr/local/sbin/marexcode-web-deploy` (105).
3. Recharger ; les couleurs suivent Monaco, MarexFile et SSH.

### Vider un cache récalcitrant
- Page : `Ctrl+Shift+R` (servie `no-store`).
- `custom.css` : `no-cache`, recharger.
- Assets : versionnés (`index-*.js`), un redéploiement change les noms.
- Vérifier les en-têtes : `curl -sI …/browser/static/assets/…`.

### Vérifier la performance
```sh
curl -sI https://marexcode.example.com/browser/static/assets/index-BOEsmRAc.css \
  | grep -iE 'cache-control|content-encoding'
# API toujours gatée
curl -s -o /dev/null -w '%{http_code}\n' https://marexcode.example.com/browser/api/resources/marexcode
```

### Panneau SSH non thémé
- Vérifier qu'on est bien sur `neva.example-tailnet.ts.net` (pas le domaine public).
- Recharger ; `syncSshTheme()` s'exécute au load et au changement de thème.
