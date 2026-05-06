#!/usr/bin/env bash
# Build a distributable zip of the Judge extension.
#
# Usage:  ./build.sh
# Output: dist/judge-v<VERSION>.zip  (+ dist/judge-latest.zip symlink)

set -euo pipefail

cd "$(dirname "$0")"

# Read version from manifest.json without jq dependency.
# (BSD sed on macOS doesn't support \s; use [[:space:]] or literal space.)
VERSION=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' manifest.json)
if [[ -z "$VERSION" ]]; then
  echo "ERROR: cannot read version from manifest.json" >&2
  exit 1
fi

NAME="judge-v${VERSION}"
DIST_DIR="dist"
ZIP_PATH="${DIST_DIR}/${NAME}.zip"
LATEST="${DIST_DIR}/judge-latest.zip"

mkdir -p "$DIST_DIR"
# 只覆盖当前版本和 latest 别名,绝不动 dist/ 下其它历史版本。
# 历史 zip 是给同事或回滚用的,千万别 `rm -rf dist`。
rm -f "$ZIP_PATH" "$LATEST"

# Files to include (extension runtime only — no source-control / build artifacts)
INCLUDE=(
  manifest.json
  background.js
  inject.js
  content.js
  popup.html
  popup.css
  popup.js
  tokens.css
  pdf.js
  pdf-report.js
  analyzer.js
  report.html
  report.css
  report.js
  icons
  README.md
  INSTALL.md
)

# Validate required files exist
for f in "${INCLUDE[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "ERROR: missing required file: $f" >&2
    exit 1
  fi
done

# Clean macOS junk before zipping
find . -name '.DS_Store' -delete 2>/dev/null || true

# Exclude patterns
EXCLUDES=(
  '*/.DS_Store'
  '*.DS_Store'
  '__MACOSX/*'
  '*.map'
)

EXCLUDE_ARGS=()
for p in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=(-x "$p")
done

echo "Packing Judge v${VERSION} → ${ZIP_PATH}"
# -r recursive, -q quiet, -9 max compression, -X strip extra attrs (smaller file)
zip -r -q -9 -X "$ZIP_PATH" "${INCLUDE[@]}" "${EXCLUDE_ARGS[@]}"

# Convenience "latest" copy (not a symlink — friendlier for Windows recipients)
cp "$ZIP_PATH" "$LATEST"

SIZE=$(du -h "$ZIP_PATH" | awk '{print $1}')
COUNT=$(unzip -l "$ZIP_PATH" | tail -n1 | awk '{print $2}')

echo ""
echo "✅ Build OK"
echo "   File:  $ZIP_PATH"
echo "   Alias: $LATEST"
echo "   Size:  $SIZE"
echo "   Files: $COUNT"
echo ""
echo "Send the zip to colleagues. They can follow INSTALL.md to load it."
