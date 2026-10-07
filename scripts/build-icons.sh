#!/bin/zsh
# Writes assets/*.svg from scripts/icon-svg.mjs, then renders them on a Mac (Quick Look draws the SVG, sips scales, iconutil packs):
#   menubar/Resources/AppIcon.icns, menubar/Resources/MenubarOn.png / MenubarOff.png (+ @2x), web/favicon.svg
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/menubar/Resources"; tmp=$(mktemp -d)
mkdir -p "$out"
node "$repo/scripts/icon-svg.mjs"
render() { # svg size out.png
  qlmanage -t -s "$2" -o "$tmp" "$1" >/dev/null 2>&1
  mv "$tmp/$(basename "$1").png" "$3"
}
# App icon: a full-bleed 1024 square (macOS applies the rounded shape; a transparent margin would get it a grey tile).
set=$tmp/AppIcon.iconset; mkdir -p "$set"
render "$repo/assets/easyswitch.svg" 1024 "$tmp/full.png"
for pair in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x 128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  size=${pair%%:*}; name=${pair##*:}
  sips -z "$size" "$size" "$tmp/full.png" --out "$set/$name.png" >/dev/null
done
iconutil -c icns "$set" -o "$out/AppIcon.icns"
# Menu-bar glyphs: 18 pt, template images (the system colours them), with an @2x.
for state in on off; do
  # Quick Look draws an SVG at its own size, so the glyph is drawn large and scaled down.
  big="$tmp/glyph-$state.svg"
  sed 's/width="36" height="36"/width="360" height="360"/' "$repo/assets/glyph-$state.svg" > "$big"
  name="Menubar$(echo ${state:0:1} | tr a-z A-Z)${state:1}"
  render "$big" 360 "$tmp/$name.png"
  sips -z 36 36 "$tmp/$name.png" --out "$out/$name@2x.png" >/dev/null
  sips -z 18 18 "$tmp/$name.png" --out "$out/$name.png" >/dev/null
done
cp "$repo/assets/easyswitch-mark.svg" "$repo/web/favicon.svg"
rm -rf "$tmp"
echo "icons written to $out and web/favicon.svg"
