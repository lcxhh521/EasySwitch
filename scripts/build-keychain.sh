#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'The native Keychain helper can only be built on macOS.' >&2
  exit 1
fi
mkdir -p "$ROOT/core/native/build"
xcrun swiftc -O "$ROOT/core/native/keychain.swift" -framework Security -o "$ROOT/core/native/build/easyswitch-keychain"
chmod 700 "$ROOT/core/native/build/easyswitch-keychain"
printf '%s\n' 'Built the native Keychain helper. No Keychain entries were read or changed.'
