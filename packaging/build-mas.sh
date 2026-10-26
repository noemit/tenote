#!/usr/bin/env bash
# Builds the Mac App Store edition of Tenote: sandboxed, builtin plugins only,
# notes folder chosen by the user (security-scoped bookmark).
#
#   packaging/build-mas.sh --build-only      # compile + bundle, unsigned
#
#   MAS_PROVISIONING_PROFILE=/path/Tenote_MAS.provisionprofile \
#   SIGN_IDENTITY="Apple Distribution: Name (TEAMID)" \
#   INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Name (TEAMID)" \
#   packaging/build-mas.sh                   # signed .pkg for Transporter
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(tr -d '[:space:]' < VERSION)"
DIST=dist
APP="$DIST/Tenote.app"
PKG="$DIST/Tenote-$VERSION-mas.pkg"
BUILD_ONLY=0
[[ "${1:-}" == "--build-only" ]] && BUILD_ONLY=1

SWIFT_FLAGS=(-c release --arch arm64 --arch x86_64 -Xswiftc -DMAS --scratch-path .build-mas)
swift build "${SWIFT_FLAGS[@]}"
BIN="$(swift build "${SWIFT_FLAGS[@]}" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/plugins"
cp "$BIN/Tenote" "$APP/Contents/MacOS/Tenote"
sed "s/__VERSION__/$VERSION/g" packaging/Info-MAS.plist > "$APP/Contents/Info.plist"

# Resources: no examples/, no user plugins — every executable line ships inside
# the bundle, which is what App Review expects.
cp VERSION "$APP/Contents/Resources/"
cp packaging/PrivacyInfo.xcprivacy "$APP/Contents/Resources/"
cp -R renderer "$APP/Contents/Resources/renderer"
cp -R assets "$APP/Contents/Resources/assets"
cp -R plugins/builtin "$APP/Contents/Resources/plugins/builtin"

ICONSET="$DIST/AppIcon-mas.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" assets/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

if [[ -n "${MAS_PROVISIONING_PROFILE:-}" ]]; then
  cp "$MAS_PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
fi

if [[ $BUILD_ONLY == 1 ]]; then
  echo "built $APP (unsigned, version $VERSION)"
  exit 0
fi

: "${MAS_PROVISIONING_PROFILE:?set MAS_PROVISIONING_PROFILE to the downloaded .provisionprofile}"
: "${SIGN_IDENTITY:?set SIGN_IDENTITY to an Apple Distribution identity}"
: "${INSTALLER_IDENTITY:?set INSTALLER_IDENTITY to a Mac Installer Distribution identity}"

codesign --force --timestamp \
  --entitlements packaging/Tenote-MAS.entitlements \
  --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

rm -f "$PKG"
productbuild --component "$APP" /Applications --sign "$INSTALLER_IDENTITY" "$PKG"
echo "packaged $PKG"
echo "upload with: xcrun altool --upload-app -f \"$PKG\" -t macos --apple-id \"\$APPLE_ID\" --password \"\$APPLE_APP_SPECIFIC_PASSWORD\""
