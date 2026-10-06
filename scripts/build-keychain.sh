#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'The native Keychain helper can only be built on macOS.' >&2
  exit 1
fi
# An existing identity must be selected explicitly. Never create/import a certificate,
# silently pick another identity, or fall back to ad-hoc signing after a failure.
IDENTITY=${EASYSWITCH_KEYCHAIN_SIGN_IDENTITY:-}
case "$IDENTITY" in
  ''|*[!0-9a-fA-F]*)
    printf '%s\n' 'Set EASYSWITCH_KEYCHAIN_SIGN_IDENTITY to the 40-character SHA-1 fingerprint of your existing code-signing certificate. No certificate will be created or imported.' >&2
    exit 1 ;;
esac
if [ "${#IDENTITY}" -ne 40 ]; then
  printf '%s\n' 'The code-signing identity must be an exact 40-character certificate fingerprint.' >&2
  exit 1
fi
mkdir -p "$ROOT/core/native/build"
TMP=$(mktemp -d "$ROOT/core/native/build/.keychain-build.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
HELPER="$TMP/easyswitch-keychain"
IDENTIFIER=com.easyswitch.keychain
REQUIREMENT="identifier \"$IDENTIFIER\" and certificate leaf = H\"$IDENTITY\""
/usr/bin/xcrun swiftc -O "$ROOT/core/native/keychain.swift" -framework Security -o "$HELPER"
# Pin the same certificate and identifier across rebuilds. This is a local build;
# distribution notarization/timestamp policy is separate and is not performed here.
/usr/bin/codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" --requirements "=designated => $REQUIREMENT" --timestamp=none "$HELPER"
/usr/bin/codesign --verify --strict -R "$REQUIREMENT" "$HELPER"
chmod 700 "$HELPER"
mv -f "$HELPER" "$ROOT/core/native/build/easyswitch-keychain"
printf '%s\n' 'Built and signature-verified the native Keychain helper. Existing credential entries and their permissions were not changed.'
