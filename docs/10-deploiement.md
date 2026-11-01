# 10 — Déploiement et mises à jour

## La règle d'or de la page

La page a une **CSP stricte par hachages** : toute modification de
`/var/www/marexcode-web/index.html` (HTML, CSS inline, JS inline) change les
hachages. Il faut **immédiatement** régénérer la CSP, sinon le JS inline est bloqué
et l'écran de verrouillage reste figé.

```sh
# depuis PVE
pct push 105 /home/sam/marexcode-web-index.html /var/www/marexcode-web/index.html
pct exec 105 -- sh -c 'chown root:www-data /var/www/marexcode-web/index.html; chmod 644 /var/www/marexcode-web/index.html; /usr/local/sbin/marexcode-web-deploy'
```

`marexcode-web-deploy` :
1. calcule les SHA-256 des blocs `<style>` et `<script>` de la page,
2. écrit `/etc/nginx/snippets/marexcode-csp.conf`,
3. `nginx -t` + `systemctl reload nginx`.

## Déployer l'iframe SSH (`/ssh-ui/`)

```sh
pct push 105 <index.html> /var/www/marexcode-web/ssh-ui/index.html
pct push 105 <app.js>     /var/www/marexcode-web/ssh-ui/app.js
pct exec 105 -- sh -c 'chown root:www-data /var/www/marexcode-web/ssh-ui/*; chmod 644 /var/www/marexcode-web/ssh-ui/*'
```
La CSP de `/ssh-ui/` est statique (styles inline autorisés pour xterm) : pas de
régénération nécessaire. Si la page **parente** change, si.

## Mettre à jour le gate / marexws (102)

```sh
pct push 102 <server.js> /tmp/server.js
pct exec 102 -- sh -c '
  cp -a /opt/marexgate/server.js /root/server.js.bak-$(date +%s)
  install -m 644 /tmp/server.js /opt/marexgate/server.js
  rm -f /tmp/server.js
  node --check /opt/marexgate/server.js
  systemctl restart marexgate'
```

- Après un changement de dépendances : `cd /opt/marexgate && npm ci` (Node 24).
- `lib.js` / `webauthn.js` / `marexws.js` : mêmes précautions + redémarrage
  `marexgate` et/ou `marexws`.
- `marexws` : un restart coupe les WS (tmux garde les sessions).

## Mettre à jour marexssh (PVE)

```sh
install -m 644 <server.js> /opt/marexssh/server.js
/opt/marexssh/bin/node --check /opt/marexssh/server.js
systemctl restart marexssh
```
- Dépendances : `cd /opt/marexssh && PATH=/opt/marexssh/bin:$PATH npm ci`.
- Un restart coupe les sessions SSH en cours.

## Changer le mot de passe Basic (105)

```sh
umask 077
while :; do read -rsp 'mot de passe: ' P; echo; [ -n "$P" ] && break; done
printf 'marex:%s\n' "$(printf '%s' "$P" | openssl passwd -apr1 -stdin)" > /tmp/hp
pct push 105 /tmp/hp /etc/nginx/.htpasswd-marexcode
pct exec 105 -- sh -c 'chown root:www-data /etc/nginx/.htpasswd-marexcode; chmod 640 /etc/nginx/.htpasswd-marexcode; nginx -t && systemctl reload nginx'
rm -f /tmp/hp; unset P
```

## Changer le mot de passe maître

```sh
sudo marexgate passwd     # interactif, ≥12 caractères
```
Révoque les sessions, **garde les passkeys**. Pour tout effacer : `reset` (supprime
aussi les passkeys) ou `panic` (urgence).

## Ajouter/retirer un admin SSH Tailscale

Éditer `/etc/marexssh/config.json` (`admins`), puis `systemctl restart marexssh`.
L'identité doit exister dans le tailnet (login exact).

## Ajouter une 5e session (S5)

Voir `06-terminal-ttyd.md` (unit template, locations 102/105, `CONFIG.terminals`,
redéploiement page + CSP).

## Certificats

```sh
pct exec 105 -- certbot certificates
pct exec 105 -- certbot renew --dry-run
# nouveau domaine :
pct exec 105 -- certbot certonly --webroot -w /var/www/certbot -d <domaine>
```
Penser au vhost 105 et, si le domaine doit router, à `router-map.stream`/`.http`
sur PVE.

## Ordre de redémarrage conseillé

1. 102 : `marexgate` (DB), puis `marexws`, puis `ttyd-marexcode@1..4`,
   `filebrowser-marexcode`, `netdata`.
2. 102 : `nginx`.
3. 105 : `nginx`.
4. PVE : `marexssh`, `nginx` (le garde-fou est désactivé).
5. Vérifier : page, terminal, fichiers, métriques, SSH.

## Redéploiement complet de la page (checklist)

- [ ] Sauvegarder l'ancienne page (`cp` daté).
- [ ] Push + chown/chmod.
- [ ] `marexcode-web-deploy` (CSP + reload).
- [ ] Recharger avec **cache vidé** ; vérifier 0 violation CSP.
- [ ] Déverrouiller, tester terminal + fichiers + aperçu + métriques.
- [ ] Mobile (≤820 px).
- [ ] Si échec : restaurer l'ancienne page + `marexcode-web-deploy`.

## Rollback (fichiers fournis)

- Page : ancienne copie depuis un backup de phase (hors dépôt, `files/backups/lxc105/...`) ou
  `/root/marexcode.conf.bak-*` ne contient pas la page ; utiliser le `vzdump` ou une
  copie locale).
- Gate : `/root/p7-server.js.bak-*`, `p6-*`, `p5-*` (102) — voir `12-...`.
- Proxy : `/root/p6-server-ssh.js.bak`, `p7-server-ssh.js.bak-*` (PVE).
- Nginx : `/root/marexcode.conf.bak-p*` (102/105), `/root/nginx-backup-tout-en-un-*.tgz`.
- Après restauration : `node --check`, `nginx -t`, redémarrer les services concernés.

## Sources et déploiement (2026-10-31)

Sources sur PVE :
- page : `/home/sam/marexcode-web-index.html`
- panneau SSH : `/home/sam/marexcode-web-ssh-ui/{index.html,app.js}`
- vendors Monaco : `/home/sam/marexcode-web-vendor/monaco/`

Déploiement page :
```sh
pct push 105 /home/sam/marexcode-web-index.html /var/www/marexcode-web/index.html
install -m 644 ... ; chown root:www-data ...
# puis, OBLIGATOIRE (CSP par hachages) :
/usr/local/sbin/marexcode-web-deploy        # sur 105
```

Panneau SSH : pousser `index.html` et `app.js` dans `/var/www/marexcode-web/ssh-ui/`
(pas de régénération CSP : styles inline autorisés par la CSP de `/ssh-ui/`).

Vendors Monaco : copier dans `/var/www/marexcode-web/vendor/monaco/`, puis
`marexcode-web-deploy` (la CSP ne change pas mais le déploiement recharge nginx).

Branding MarexFile : modifier `/opt/marexfile-branding/` puis, sur 102,
`systemctl restart filebrowser-marexcode` ; si le nom/les réglages changent,
`filebrowser … config set …` (service arrêté).

**Toujours convertir en LF** un fichier venu de Windows avant de le déployer
(sinon le hachage CSP ne correspond plus).
