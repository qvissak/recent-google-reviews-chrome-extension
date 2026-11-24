#!/usr/bin/env bash
# What: Builds the zip to upload to the Chrome Web Store: only the files the extension runs, named after the manifest version.
# Who calls it / when: you, before each upload (npm run package).
# Gotchas: bump "version" in manifest.json first, because the store rejects an upload that does not increase it.
#          icons/*.svg are the icon sources and stay out; the PNGs are what Chrome uses.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="dist/recent-reviews-$version.zip"

mkdir -p dist
rm -f "$out"
zip -X -r "$out" manifest.json icons/*.png src styles.css -x '*.DS_Store'
# Guard: only the extension's own files may be in the zip. A stray .md, rules or notes file under src/ would otherwise ship.
unexpected=$(unzip -Z1 "$out" | grep -v '/$' | grep -v -E '^(manifest\.json|styles\.css|icons/icon-[0-9]+\.png|src/.+\.(js|html|css))$' || true)
if [ -n "$unexpected" ]; then
  echo "Refusing to ship: unexpected files in $out:" >&2
  echo "$unexpected" >&2
  rm -f "$out"
  exit 1
fi

echo "Built $out"
