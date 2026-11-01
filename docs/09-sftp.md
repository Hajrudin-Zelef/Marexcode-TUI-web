# 09 — SFTP intégré

## Principe

Le SFTP utilise **la même connexion SSH** que le terminal (`ssh2.client.sftp()`),
dans le même `marexssh`. L'onglet « Fichiers » de l'iframe SSH permet de parcourir,
téléverser, télécharger, renommer, créer un dossier, dupliquer et prévisualiser.

**Interdits par conception** : suppression, `chmod`, éditeur de contenu.
Contournement possible uniquement par renommage/écrasement (pas de destruction).

## Session SFTP

- À l'ouverture du shell, `marexssh` ouvre le canal SFTP et renvoie
  `{type:"sftp-ready", token, home, root, max_bytes, preview_bytes}`.
- `token` : 24 octets aléatoires, **gardé en mémoire**, jamais journalisé.
- Requêtes WS (même connexion) :

| Message | Effet |
|---|---|
| `sftp-list {path}` | `{path, entries:[{name,type,size,mtime,mode}], truncated}` |
| `sftp-mkdir {path}` | crée un dossier |
| `sftp-rename {from,to}` | renomme (refuse si `to` existe) |
| `sftp-copy {from,to}` | duplique (refuse si `to` existe) |
| `sftp-download {path}` | renvoie une **URL à usage unique** 60 s |
| `sftp-authorize-root {ticket}` | active `/` avec un ticket `sftp_root` |
| `sftp-home` | revient à la racine = home |

## Endpoints HTTP (sur `marexssh`, via `/ssh/`)

| Méthode | Chemin | Auth | Rôle |
|---|---|---|---|
| POST | `/ssh/sftp/upload` | `X-Marex-Sftp` + `X-Marex-Path` (+ `X-Marex-Overwrite: 1`) | upload streaming |
| GET | `/ssh/sftp/preview` | `X-Marex-Sftp` + `X-Marex-Path` | aperçu ≤ 256 Ko |
| GET | `/ssh/sftp/download?t=…` | jeton URL usage unique | téléchargement `attachment` |

- `X-Marex-Path` = chemin absolu **encodé** (`encodeURIComponent`).
- Upload vers un fichier existant sans `X-Marex-Overwrite` → **409** ; l'UI demande
  confirmation puis renvoie avec `X-Marex-Overwrite: 1`.
- Les endpoints exigent aussi l'identité Tailscale (Serve) + le jeton de session.

## Confinement

- Racine = **home distant** (`realpath('.')`) par défaut.
- `realpath` est résolu ; le chemin doit être **égal ou sous** la racine.
- Symlinks sortants refusés (`outside_root`) ; les symlinks internes fonctionnent.
- Pour lire `/`, il faut un ticket **`sftp_root`** (step-up maître) :
  le parent fait `ensureStepUp()` puis `POST /gate/ssh/ticket {sftp_root:true}` avec
  `X-Step-Up`, transmet le ticket à l'iframe qui l'envoie sur la WS.
  Un ticket normal ne suffit pas.
- « Revenir au home » ne demande pas de step-up (`sftp-home`).

## Limites

| Limite | Valeur |
|---|---|
| Taille transfert | 2 Go (`sftp.max_bytes`) |
| Aperçu | 256 Ko (`sftp.preview_bytes`) |
| Transferts simultanés | 2 (`sftp.concurrent`) |
| Entrées listées | 2000 (`sftp.max_entries`) |
| Jeton de téléchargement | 60 s, usage unique |

## Aperçu sans XSS

- `text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff` pour tout texte/code,
  **même HTML/SVG** (jamais rendu).
- Images (png/jpeg/gif/webp) en `image/*`, affichées via un blob côté page.
- Autres binaires → `415 unsupported`.
- Téléchargements en `Content-Disposition: attachment; filename*=UTF-8''…`.

## UI

- Onglet **Fichiers** après connexion SSH.
- Barre : Home, parent, chemin, refresh, « Afficher la racine », « Nouveau dossier »,
  « Importer » (multi + glisser-déposer).
- Double action par ligne : renommer, dupliquer, télécharger ; clic dossier = entrer,
  clic fichier = aperçu.
- Aperçu : texte dans `<pre>`, images en `<img>`, bouton télécharger.
- Mobile : liste adaptée, pas de débordement.

## Révocation

La revalidation SSH (cookie device, 30 s) coupe la WS et détruit les flux actifs
(`session.streams`), donc un transfert en cours s'arrête. Testé : révocation →
session fermée en ~27 s.

## Dépannage

| Erreur | Cause |
|---|---|
| `outside_root` | chemin/symlink hors racine |
| `bad_session` | jeton expiré (WS fermée) → reconnecter |
| `exists` | rename/copy vers un fichier existant |
| `too_large` | > 2 Go (ou aperçu > 256 Ko) |
| `unsupported` | aperçu binaire non image |
| 401/403 HTTP | identité Tailscale absente ou jeton invalide |
| `root_denied` | ticket sans `sftp_root` (step-up requis) |
| Liste vide | dossier réellement vide (les dotfiles sont visibles) |

## Restauration

Le SFTP ne stocke rien côté serveur (hors fichiers distants). Rien à restaurer dans
le bundle ; les fichiers sont sur la machine distante. Le code/état `marexssh`
(`known_hosts.json`, `audit.jsonl`) n'est **pas** dans le dépôt (hors dépôt, machine PVE).
