#!/bin/sh
# Builds app/build/Lookma.app with swiftc (no Xcode project), from Info.plist, Sources/ and
# Resources/ (the app icon and menu bar images, copies of brand/ made by brand/src/build.sh).
# The version is stamped from package.json, its only source.
# Signing: macOS ties Accessibility / Screen Recording grants to the app's signature. A real
# signing identity keeps those grants across rebuilds; ad-hoc signing loses them on every build.
# Uses $LOOKMA_SIGN_IDENTITY, else the first Developer ID / Apple Development identity found,
# else ad hoc. Set LOOKMA_SIGN_IDENTITY=- to force ad hoc.
set -eu
cd "$(dirname "$0")"
APP=build/Lookma.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
VERSION=$(plutil -extract version raw -o - ../package.json)
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
cp -R Resources "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos15.0" Sources/*.swift -o "$APP/Contents/MacOS/Lookma"

IDENTITY=${LOOKMA_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null |
  grep -oE '"(Developer ID Application|Apple Development): [^"]*"' | head -1 | tr -d '"')}
IDENTITY=${IDENTITY:--}
if [ "$IDENTITY" = "-" ]; then
  echo "signing ad hoc (permissions must be granted again after each rebuild)"
else
  echo "signing with your identity (macOS may ask once to let codesign use the key: click Always Allow)"
fi
codesign --force --sign "$IDENTITY" "$APP"
echo "built $APP"
