#!/usr/bin/env bash
# Builds dist/Tenote Native.app (universal) from the Swift package, and optionally
# signs, notarizes and zips/dmgs it.
#
#   packaging/build-app.sh                 # unsigned .app (ad-hoc signed)
#   SIGN_IDENTITY="Developer ID Application: …" packaging/build-app.sh --dist
#   (notarization also needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(tr -d '[:space:]' < VERSION)"
DIST=dist
APP="$DIST/Tenote Native.app"
DO_DIST=0
[[ "${1:-}" == "--dist" ]] && DO_DIST=1

swift build -c release --arch arm64 --arch x86_64
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Tenote" "$BIN/tenotectl" "$APP/Contents/MacOS/"
sed "s/__VERSION__/$VERSION/g" packaging/Info.plist > "$APP/Contents/Info.plist"
cp VERSION "$APP/Contents/Resources/"
cp -R renderer plugins examples assets "$APP/Contents/Resources/"

ICONSET="$DIST/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

IDENTITY="${SIGN_IDENTITY:--}"
codesign --force --options runtime --timestamp=none --entitlements packaging/Tenote.entitlements \
  --sign "$IDENTITY" "$APP/Contents/MacOS/tenotectl"
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --deep --entitlements packaging/Tenote.entitlements --sign - "$APP"
else
  codesign --force --options runtime --timestamp --entitlements packaging/Tenote.entitlements --sign "$IDENTITY" "$APP"
fi
echo "built $APP ($VERSION)"

[[ $DO_DIST == 1 ]] || exit 0

ZIP="$DIST/TenoteNative-$VERSION-universal.zip"
DMG="$DIST/TenoteNative-$VERSION-universal.dmg"
ditto -c -k --keepParent "$APP" "$ZIP"
if [[ -n "${APPLE_ID:-}" && "$IDENTITY" != "-" ]]; then
  xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP" && ditto -c -k --keepParent "$APP" "$ZIP"
fi
STAGE="$DIST/dmg"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Tenote Native" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
if [[ "$IDENTITY" != "-" ]]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  if [[ -n "${APPLE_ID:-}" ]]; then
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$DMG"
  fi
fi
echo "packaged $ZIP and $DMG"
