#!/bin/sh
# Reconstruit le bundle Monaco utilisé par la page (app/vendor/monaco/).
# Prérequis : bun, npm, accès réseau à registry.npmjs.org.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BUN=${BUN:-bun}
VERSION=${MONACO_VERSION:-0.57.0}

cd "$TMP"
npm pack "monaco-editor@$VERSION" >/dev/null
tar xzf monaco-editor-*.tgz

mkdir -p build
cat > build/entry.js <<'EOF'
import * as monaco from "../package/esm/vs/editor/editor.api.js";
import "../package/esm/vs/basic-languages/monaco.contribution.js";
import "../package/esm/vs/language/json/monaco.contribution.js";
self.monaco = monaco;
self.dispatchEvent(new Event("marex-monaco-ready"));
EOF
cat > build/worker.js <<'EOF'
import "../package/esm/vs/editor/editor.worker.js";
EOF
cat > build/json-worker.js <<'EOF'
import "../package/esm/vs/language/json/json.worker.js";
EOF

cd build
"$BUN" build entry.js --outdir=dist --target=browser --format=esm --minify
"$BUN" build worker.js --outfile=editor.worker.js --target=browser --format=iife --minify
"$BUN" build json-worker.js --outfile=json.worker.js --target=browser --format=iife --minify

OUT="$ROOT/app/vendor/monaco"
mkdir -p "$OUT"
cp dist/entry.js "$OUT/monaco.bundle.js"
cp dist/entry.css "$OUT/monaco.css"
cp dist/*.ttf "$OUT/" 2>/dev/null || true
cp editor.worker.js json.worker.js "$OUT/"
echo "Monaco reconstruit dans $OUT"
