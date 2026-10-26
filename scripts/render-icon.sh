#!/usr/bin/env bash
# Renders the app icon from its SVG source.
#   assets/icon.svg  ->  assets/icon.png  (1024x1024, RGBA, transparent corners)
# macOS-only: sips reads SVG and writes PNG. The PNG is committed, so this only
# needs to run when the SVG changes.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -t tenote-icon).png"
sips -s format png assets/icon.svg --out "$tmp" >/dev/null
w=$(sips -g pixelWidth "$tmp" | awk '/pixelWidth/{print $2}')
h=$(sips -g pixelHeight "$tmp" | awk '/pixelHeight/{print $2}')
[[ "$w" == "1024" && "$h" == "1024" ]] || { echo "expected 1024x1024, got ${w}x${h}" >&2; exit 1; }
mv "$tmp" assets/icon.png
echo "rendered assets/icon.png (${w}x${h})"
