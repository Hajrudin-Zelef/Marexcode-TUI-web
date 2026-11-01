# 19 — Monaco (éditeur VS Code)

## Rôle

Volet droit `#monaco` : affiche du code avec la coloration Monaco, dans le style
VS Code (minimap, numéros de ligne), **en lecture seule**.

## Réglages

- Taille de police (10–20), minimap, retour à la ligne et tabulation se règlent
  dans **Réglages → Monaco** (`marex.settings`), appliqués à chaud via
  `updateOptions`.

## Activation

- Bouton header **Monaco** (`#btnMonaco`), à côté de SSH. Un clic ouvre, un autre ferme
  (comme Fichiers).
- À l'ouverture, le terminal (`#center`) rétrécit ; Monaco prend la colonne droite
  (520 px par défaut).
- Séparateurs redimensionnables : `#rsplitFiles` (Fichiers | Terminal) et
  `#rsplitMonaco` (Terminal | Monaco) — glisser, flèches ◀ ▶ (pas de 40 px, sens
  inversé côté Monaco), double-clic = reset.
- Largeurs et état ouvert mémorisés : `marex.files.w`, `marex.monaco.w`,
  `marex.files.open`, `marex.monaco.open` (localStorage).

## Ouvrir un fichier

- clic sur un fichier dans **MarexFile** quand Monaco est ouvert (sinon, visionneuse) ;
- champ chemin dans l'en-tête Monaco + Entrée ;
- bouton **« Ouvrir dans Monaco »** dans la visionneuse.

## Contenu et limites

- Source : API MarexFile `/browser/api/raw/<chemin>?inline=true` (même origine).
- Limite **3 Mo** ; fichier binaire (octet NUL) refusé ; message dans le volet.
- Langage déduit de l'extension (basic-languages + service JSON).
- `Ctrl+S` n'écrit rien : les fichiers sont en lecture seule par conception.
- Au **verrouillage** (`lockUI`) : Monaco se ferme, le modèle est détruit, le contenu
  effacé.

## Bundle local (autonome)

Dossier 105 : `/var/www/marexcode-web/vendor/monaco/` (source miroir PVE :
`/home/sam/marexcode-web-vendor/monaco/`) :

| Fichier | Rôle |
|---|---|
| `monaco.bundle.js` | monaco-editor **0.57** ESM, IIFE → `self.monaco`, événement `marex-monaco-ready` |
| `monaco.css` | styles (contient `codicon-*.ttf` référencé en relatif) |
| `editor.worker.js` | worker éditeur |
| `json.worker.js` | worker JSON (validation, commentaires tolérés) |
| `codicon-mxdk0fnd.ttf` | police d'icônes |

- Chargement **paresseux** au premier clic (4,4 Mo, mis en cache ensuite).
- `MonacoEnvironment.getWorker` route `json` → `json.worker.js`, sinon `editor.worker.js`.
- Thème `marex-<id>` recalculé depuis les variables CSS à chaque changement de thème
  (fond, texte, accent, sélection, scrollbars, minimap).

## Reconstruire le bundle

```sh
# sur 102, avec Bun et le paquet monaco-editor 0.57
mkdir build && cd build
npm pack monaco-editor            # ou npm i monaco-editor@0.57.0
tar xzf monaco-editor-0.57.0.tgz
cat > entry.js <<'EOF'
import * as monaco from "../package/esm/vs/editor/editor.api.js";
import "../package/esm/vs/basic-languages/monaco.contribution.js";
import "../package/esm/vs/language/json/monaco.contribution.js";
self.monaco = monaco;
self.dispatchEvent(new Event("marex-monaco-ready"));
EOF
cat > worker.js <<'EOF'
import "../package/esm/vs/editor/editor.worker.js";
EOF
cat > json-worker.js <<'EOF'
import "../package/esm/vs/language/json/json.worker.js";
EOF
bun build entry.js --outdir=dist --target=browser --format=esm --minify
bun build worker.js --outfile=editor.worker.js --target=browser --format=iife --minify
bun build json-worker.js --outfile=json.worker.js --target=browser --format=iife --minify
```

Copier `dist/entry.js` → `monaco.bundle.js`, `dist/entry.css` → `monaco.css`,
`dist/codicon-*.ttf`, les deux workers. Puis `marexcode-web-deploy` (CSP inchangée).

## Pièges

- Ne pas utiliser le build AMD (`min/vs/loader.js`) : CSP stricte.
- Ne pas passer en `script-src 'unsafe-eval'` : le bundle ESM n'en a pas besoin.
- `style-src 'unsafe-inline'` est requis (Monaco injecte des styles) ; `worker-src 'self' blob:`.
- Le nom du fichier codicon est **haché** : le copier tel quel, le CSS y fait référence.
- Sur mobile, Monaco est en overlay plein écran ; les séparateurs sont masqués.
