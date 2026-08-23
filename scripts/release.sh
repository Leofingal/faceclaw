#!/bin/bash
# Build a signed release APK at dist/Faceclaw-<version>.apk, where <version>
# comes from FACECLAW_VERSION in app/version.ts.
#
# Prompts for the keystore passphrase. Override the keystore location with
# ANDROID_KEYSTORE=/path/to/store.jks.
#
# Note: the passphrase is passed to the nativescript CLI on its command line,
# so it is briefly visible in `ps` on this machine while the build runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEYSTORE="${ANDROID_KEYSTORE:-$HOME/repositories/AndroidKeystore/jimrandomh-android-keystore.jks}"
if [ ! -f "$KEYSTORE" ]; then
  echo "Keystore not found: $KEYSTORE (set ANDROID_KEYSTORE to override)" >&2
  exit 1
fi

# build.sh is the machine-specific wrapper that exports JAVA_HOME/ANDROID_HOME.
# Pick up its exports so keytool and the build use the same JDK.
if [ -f build.sh ]; then
  eval "$(grep '^export ' build.sh)"
fi
if ! command -v keytool >/dev/null; then
  echo "keytool not found; set JAVA_HOME (usually via build.sh)" >&2
  exit 1
fi

VERSION="$(sed -n 's/^export const FACECLAW_VERSION = "\([^"]*\)".*/\1/p' app/version.ts)"
if [ -z "$VERSION" ]; then
  echo "Could not read FACECLAW_VERSION from app/version.ts" >&2
  exit 1
fi

read -r -s -p "Keystore passphrase for $(basename "$KEYSTORE"): " STORE_PASS
echo

# Validate the passphrase up front and discover the signing-key alias.
if ! LISTING="$(keytool -list -keystore "$KEYSTORE" -storepass "$STORE_PASS" 2>&1)"; then
  printf '%s\n' "$LISTING" >&2
  exit 1
fi
ALIAS="$(printf '%s\n' "$LISTING" | awk -F', ' '/PrivateKeyEntry/{print $1; exit}')"
if [ -z "$ALIAS" ]; then
  echo "No private-key entry found in $KEYSTORE:" >&2
  printf '%s\n' "$LISTING" >&2
  exit 1
fi
echo "Signing as '$ALIAS', version $VERSION"

read -r -s -p "Key passphrase for '$ALIAS' (empty = same as keystore): " KEY_PASS
echo
KEY_PASS="${KEY_PASS:-$STORE_PASS}"

OUT="dist/Faceclaw-$VERSION.apk"
mkdir -p dist
rm -f "$OUT"

npx nativescript build android --release \
  --key-store-path "$KEYSTORE" \
  --key-store-password "$STORE_PASS" \
  --key-store-alias "$ALIAS" \
  --key-store-alias-password "$KEY_PASS" \
  --copy-to "$OUT"

echo
echo "Built $OUT"
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
  APKSIGNER="$(printf '%s\n' "$ANDROID_HOME/build-tools"/*/apksigner | sort -V | tail -1)"
  [ -x "$APKSIGNER" ] && "$APKSIGNER" verify --print-certs "$OUT" | head -5
fi
