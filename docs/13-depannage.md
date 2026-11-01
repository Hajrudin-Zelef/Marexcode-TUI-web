# 13 — Dépannage

## Accès / auth

### 401 sur la page (même avec le bon mot de passe Basic)
- Vérifier l'utilisateur Basic : `marex` (pas `qa` ni autre).
- `fail2ban` a peut-être banni ton IP :
  `pct exec 105 -- fail2ban-client status nginx-ttyd` → `unbanip`.
- Le portail n'est **pas** le Basic auth : deux mots de passe différents.
- Si le Basic auth est bon mais le portail refuse : mot de passe maître/TOTP.

### 401 dans l'iframe Fichiers
- Cause historique : iframe **cross-origin** `fichiers.example.com` (le navigateur
  ne renvoie pas les identifiants de l'origine parente).
- Correctif appliqué : File Browser est monté sous `/browser/` (même origine).
  Si tu vois encore l'ancienne URL, vide le cache / recharge.

### Cookie non conservé
- `__Host-marexgate` exige **HTTPS**, `Path=/`, sans `Domain`.
- Un cookie créé sur `marexcode.example.com` n'est pas valable sur
  `neva.example-tailnet.ts.net` (et inversement) : se déverrouiller sur chaque origine.

### « Passkey refusée » / aucune passkey
- RP différent : enregistrer une passkey sur ce domaine (public **ou** ts.net).
- Après suppression de la dernière passkey, le bouton passkey disparaît : utiliser
  le maître.
- `login/options` → 404 `no_passkey` = aucune passkey pour ce domaine (normal).

### Mot de passe maître perdu
- `sudo marexgate reset` puis `sudo marexgate passwd` (supprime aussi les passkeys).

### `marexgate: runuser: not found`
- Ancien wrapper. Le wrapper actuel utilise `sudo` + `setpriv`. Réinstaller
  `/usr/local/bin/marexgate` depuis le bundle.

### 429 / trop de tentatives
- App : 10 échecs/10 min ; nginx : `gate` 5 r/s ; attendre ou `unbanip`.
- Ne pas insister : le compteur est par IP réelle.

## Page / CSP

### Page blanche, overlay figé, boutons morts
- **CSP non régénérée** après modification de la page : le JS inline est bloqué.
- Correctif : `pct exec 105 -- /usr/local/sbin/marexcode-web-deploy`.
- Vérifier dans la console : `Content Security Policy` / `securitypolicyviolation`.
- Vérifier le hash : le header CSP doit correspondre au contenu actuel.

### Icônes géantes, clics sans effet, styles absents
- Ancien HTML en cache sans préfixe d'assets (souvent `/files/` au lieu de `/browser/`).
- Vider le cache ; vérifier que la page est servie en `Cache-Control: no-store`.
- File Browser doit être sous `-b /browser` (pas `/files`).

### Terminal « Reconnecting… »
- `marexws`/ttyd arrêté : `systemctl status marexws 'ttyd-marexcode@1'`.
- Cookie expiré/révoqué : `auth_request` 401 → se reconnecter.
- `setTimeout` > 24,8 j : ancien bug de `marexws` (TTL 30 j) — corrigé ; vérifier
  que la version déployée n'a plus de timer absolu.
- `607`/407 : `X-Remote-User` absent (normal en direct sans 105).

### `407 Proxy Auth Required` (ttyd)
- ttyd est lancé avec `-H X-Remote-User` ; sans cet en-tête il renvoie 407.
- 105 le pose depuis `$remote_user`. Un test direct sur `10.0.0.102:80` doit
  envoyer `X-Remote-User`.

### 503/429 sur la page
- Rate limit trop bas (`ttyd` 20 r/s burst 50). La page charge iframe + WS +
  métriques toutes les 3 s.
- Vérifier `limit_req zone=ttyd` sur 105.

## Fichiers / file browser

### 403 « You don't have permissions » sur `.agents`, `.ssh`…
- Un `location ~ /\.` dans le vhost bloquait les dossiers cachés. Retiré.
- Les dotfiles sont désormais bloqués uniquement par
  `location ~ ^/browser/.*/\.` → 404 (normal).

### Clic qui ne fait que sélectionner / grille géante
- `singleClick=true` et `viewMode=list` manquants :
  `filebrowser ... users update admin --singleClick --viewMode=list`.

### Écriture impossible (créer/renommer/supprimer)
- **Normal** : File Browser est en lecture seule (permissions false, download true).
- C'est une décision de sécurité ; l'édition se fait via le terminal ou SFTP.

### Dossiers cachés visibles dans SFTP
- Normal : le SFTP voit le home distant tel quel (dotfiles inclus).

## Monitoring

### Barre vide / `—`
- Netdata arrêté ou mauvais bind : `ss -tln | grep 19999` ; `[web] bind to`.
- `/metrics/` non proxifié (105 → 102 vhost stats) ; `auth_request` cookie ?
- `journalctl -u netdata`, nginx logs.

### Unités fausses (`Disque 0/0`, réseau en Mo/s au lieu de Mb/s)
- Netdata : RAM en MiB, disque en GiB, réseau en kilobits/s. Corriger l'affichage,
  pas Netdata.

### Dashboard Netdata dans la page
- Volontairement retiré : il refuse l'iframe et pollue la page. La barre suffit.

## SSH

### Bouton SSH → « accessible uniquement via Tailscale »
- Normal sur `marexcode.example.com`. Ouvrir `https://neva.example-tailnet.ts.net:8443/`
  depuis un appareil connecté au tailnet.

### 403 à l'ouverture de la WS
- `Tailscale-User-Login` absent ou non admin. Vérifier `admins` dans
  `/etc/marexssh/config.json`, `tailscale status`.
- Ne pas appeler 8791 directement depuis l'extérieur (loopback only).

### `bad_ticket` / ticket expiré
- Le ticket dure 60 s et est à usage unique : recharger la page/relancer.
- Horloge serveur/client décalée ? Vérifier `timedatectl`.

### `destination_denied`
- Hôte hors `100.64.0.0/10`, `10.0.0.0/24`, `192.168.1.0/24`.
- IPv6 refusé. Vérifier la résolution (toutes les IP doivent être autorisées).

### `bad_port`
- Seuls 22 et 2222 sont autorisés.

### `host_key_changed`
- La clé d'hôte a changé. Vérifier hors bande (rebuild légitime ?), puis
  `sudo marexssh forget <hôte:port>` (redémarre le service).

### Identifiants refusés
- `ssh_error` = authentification/SSH échoué. Tester `ssh user@host` depuis PVE.
- Vérifier la clé (format OpenSSH/PEM), la passphrase, le mot de passe.

### Session coupée après ~30 s
- Revalidation du cookie : l'appareil a été révoqué/expiré. Re-déverrouiller.
- Ou le gate est injoignable : dans ce cas la session **reste** (fail-open) ;
  vérifier les logs pour d'autres causes.

### `too_many_sessions`
- 3/appareil, 6/login. Fermer des sessions ou attendre.

## SFTP

| Erreur | Cause |
|---|---|
| `outside_root` | symlink/chemin hors home (ou racine non autorisée) |
| `bad_session` | WS fermée / jeton expiré → reconnecter |
| `exists` | rename/copy vers un fichier existant |
| `too_large` | > 2 Go / aperçu > 256 Ko |
| `unsupported` | aperçu binaire non image |
| `root_denied` | ticket sans `sftp_root` (step-up) |
| 409 à l'upload | fichier existant → confirmer l'écrasement |

## Réseau / TLS

### 400 Bad Request / connexion fermée sur 105:443
- PROXY protocol incohérent : PVE `stream` doit avoir `proxy_protocol on`, et
  chaque `listen 443` de 105 doit avoir `proxy_protocol`. Ne pas en retirer un seul.

### Toutes les IP vues = 10.0.0.1
- `real_ip`/`set_real_ip_from` manquant sur 105, ou log non partagé.
  fail2ban ne peut alors pas bannir correctement.

### Cert expiré / erreur TLS
- `pct exec 105 -- certbot renew` puis reload nginx ; vérifier DNS/port 80.

### Un domaine ne répond pas
- Route SNI absente (mais défaut → 105) ; vhost 105 manquant ; cert manquant ;
  DNS non pointé ; NAT 80/443 → 105.

## Hôte / sauvegardes

### `/mnt/backup` plein (75 %, 33 Go libres)
- Les archives 102 font 22–23 Go × 3. Déplacer le job vers `/mnt/data` (496 Go)
  ou réduire la rétention ; ne pas supprimer la dernière archive.

### `vzdump` en échec
- Lire `/mnt/backup/dump/vzdump-lxc-<id>-*.log`.
- Espace insuffisant, VM verrouillée, stockage indisponible.

### `gate.db` corrompue
- Restaurer le snapshot cohérent du bundle (VACUUM INTO) ou `.db`+`-wal`+`-shm`
  service arrêté.

### Ce bundle ne restaure pas Tailscale
- Réauthentifier le nœud puis recréer Serve (`tailscale serve ...`). L'ACL est
  dans la console d'admin.

## Fichiers de secours

- Plan complet : `reference/plan-securite-web.md`.
- Spec Operator : `reference/operator-spec-marexcode-web-tui.md`.
- Topologie PVE : `reference/infra-neva-lxc.md`.
- Anciens backups de phase : hors dépôt (`files/backups/`).

## Pannes liées à MarexFile / thèmes / Monaco (2026-10-31)

### La page affiche encore l'ancien design / l'ancien nom
- Rechargement forcé (`Ctrl+Shift+R`) ; la page est `no-store`, mais le navigateur
  peut garder une ancienne copie d'un onglet.
- Vérifier `md5sum /var/www/marexcode-web/index.html` (105) et que
  `marexcode-web-deploy` a été relancé.

### Monaco vide / « Monaco n'a pas pu être chargé »
- Vérifier `/browser/static/assets` et `/vendor/monaco/*` en 200.
- CSP : `worker-src 'self' blob:` et `style-src 'unsafe-inline'` requis.
- Le bundle doit être **ESM** (`<script type="module">`), pas AMD.
- Console : `import.meta` hors module = mauvais build.

### MarexFile reste clair / pas de logo
- Le thème est injecté par la page (`syncFileBrowserTheme`) : vérifier que l'iframe
  est bien `/browser/` (same-origin) et que le thème est appliqué.
- Le logo dépend de `branding.files` : `config cat` doit montrer
  `/opt/marexfile-branding` ; sinon `config set` (service arrêté).
- Si le logo n'apparaît pas dans un panneau étroit : `custom.css` manquant.

### Le panneau SSH reste vert
- Être sur `neva.example-tailnet.ts.net` (le panneau n'existe pas en public).
- Recharger ; sinon vérifier `#marex-ssh-theme` dans l'iframe (DevTools).

### 401 sur les assets statiques après mise à jour
- Une ancienne config nginx (avec `auth_request` sur tout `/browser/`) est encore
  chargée : `nginx -t && systemctl reload nginx` (102 et 105).
- Vérifier la présence des locations `/browser/static/` dans les deux vhosts.

### Cache « collé » après changement de logo
- `img/` est en cache 1 jour, `custom.css` en `no-cache`.
- Tester en navigation privée ou vider le cache ; les assets versionnés changent
  de nom à chaque build.
