#!/bin/bash
# Builds a cleaned snapshot of EasySwitch for a public release and checks it. Publishes NOTHING.
#
# usage: tools/release/make-public-snapshot.sh <git-ref> <output-dir>
#   e.g. tools/release/make-public-snapshot.sh dev /tmp/easyswitch-public
#
# What it does:
#   1. exports the files of <git-ref> (no history) into <output-dir>
#   2. removes PROVENANCE.md and strips the <!-- private:start --> ... <!-- private:end --> blocks everywhere
#   3. runs release-check.py on the result and exits with its status
#
# Publishing is a manual step done only after this passes: create a NEW empty repository, copy the
# snapshot in, and make ONE first commit. The history of the private repository is never pushed.
set -euo pipefail
ref="${1:?git ref (e.g. dev)}"
out="${2:?output directory}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="${ES_REPO:-$(cd "$here/../.." && pwd)}"

[ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ] && { echo "refusing to write into a non-empty directory: $out"; exit 2; }
mkdir -p "$out"
git -C "$repo" archive "$ref" | tar -x -C "$out"

rm -f "$out/PROVENANCE.md" "$out/BACKLOG.md" "$out/HANDOVER.md"
rm -rf "$out/research" "$out/.claude" "$out/tools/release"
python3 - "$out" <<'EOF'
import os, re, sys
root = sys.argv[1]
block = re.compile(r"<!-- private:start -->.*?<!-- private:end -->\n?", re.S)
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d != ".git"]
    for name in filenames:
        path = os.path.join(dirpath, name)
        if os.path.islink(path):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        new = block.sub("", text)
        if new != text:
            open(path, "w", encoding="utf-8").write(new.rstrip("\n") + "\n")
            print("stripped private blocks:", os.path.relpath(path, root))
EOF

echo
python3 "$here/release-check.py" "$out" --allow "$here/release-allow.json"
