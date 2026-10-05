#!/bin/zsh
# Builds menubar/build/EasySwitch.app from menubar/main.swift with the
# Command Line Tools swiftc. The repo and Node paths are baked into Info.plist.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
node_bin=${EASYSWITCH_NODE:-$(command -v node)}
app="$repo/menubar/build/EasySwitch.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/EasySwitch" "$repo/menubar/main.swift" -framework AppKit -framework WebKit

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>EasySwitch</string>
  <key>CFBundleDisplayName</key><string>EasySwitch</string>
  <key>CFBundleIdentifier</key><string>dev.easyswitch.menubar</string>
  <key>CFBundleExecutable</key><string>EasySwitch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>EasySwitchRepo</key><string>$repo</string>
  <key>EasySwitchNode</key><string>$node_bin</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "built $app"
