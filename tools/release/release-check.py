#!/usr/bin/env python3
"""Scans a candidate public tree for anything that must not be published.

usage: release-check.py <directory> [--allow release-allow.json]

Exit code 0 only when nothing is found. Findings are grouped by kind. Nothing is ever deleted or published here.
"""
import json
import os
import re
import sys
from urllib.parse import unquote, urlsplit

NAMES = re.compile(r"opencodex|magpie|cc[ -]?switch|lobe-?icons|lobehub|jawcode|CLIProxyAPI|OmniRoute|cli-jaw|yetone|farion1231", re.I)
ATTRIBUTION = re.compile(r"\(MIT[,)]|\bMIT License\b|Copyright \(c\)|\bAdapted from|\bPorted from|\bDerived from|\bLearned from|\bDesign(?:ed)? after|\bthird_party\b|PROVENANCE")
SECRETS = [
    ("Google OAuth client secret", re.compile(r"GOCSPX-[A-Za-z0-9_-]{20,}")),
    ("Google OAuth client id", re.compile(r"[0-9]{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com")),
    ("API key (sk-)", re.compile(r"\bsk-[A-Za-z0-9]{20,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Slack token", re.compile(r"\bxox[bpas]-[A-Za-z0-9-]{20,}")),
]
PERSONAL = re.compile(r"/Users/alexyoung|alexyoung")
INTERNAL_MARKERS = re.compile(r"\b(?:B[0-9]+|(?i:dot|gpt-wip))\b")
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^\s)]+)(?:\s+['\"][^'\"]*['\"])?\)")
FORBIDDEN_FILES = {"PROVENANCE.md", "SOURCES.md", "BACKLOG.md", "BACKLOG-DONE.md", "HANDOVER.md"}
SKIP_DIRS = {".git", "node_modules"}
MAX_BYTES = 2_000_000


def load_allow(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as source:
        return [(re.compile(a["path"]), re.compile(a["pattern"], re.I)) for a in json.load(source)]


def allowed(allow, rel, text):
    return any(p.search(rel) and q.search(text) for p, q in allow)


def markdown_link_issues(root, rel, text):
    """Check local file targets, never browse or fetch links. Ignore fenced examples."""
    content = re.sub(r"(?ms)^```[^\n]*\n.*?^```\s*$", "", text)
    root = os.path.realpath(root)
    for match in MARKDOWN_LINK.finditer(content):
        target = match.group(1).strip("<>")
        try:
            url = urlsplit(target)
        except ValueError:
            yield target
            continue
        if url.scheme or url.netloc or not url.path:
            continue
        path = unquote(url.path)
        destination = os.path.realpath(os.path.join(root, path.lstrip("/")) if path.startswith("/")
                                       else os.path.join(root, os.path.dirname(rel), path))
        if os.path.commonpath([root, destination]) != root or not os.path.exists(destination):
            yield target


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    root = args[0]
    allow = load_allow(args[args.index("--allow") + 1] if "--allow" in args else None)
    findings = {}

    def add(kind, rel, detail):
        findings.setdefault(kind, []).append(f"{rel}: {detail}")

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == "third_party" or rel_dir.startswith("third_party" + os.sep):
            add("third-party notices still present (rewrite the copies, then remove)", rel_dir, ", ".join(filenames) or "(directory)")
        for name in filenames:
            path = os.path.join(dirpath, name)
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if name in FORBIDDEN_FILES:
                add("files that must not be published", rel, "")
            if name == "LICENSE" and rel != "LICENSE" and not rel.startswith("third_party"):
                add("licence files other than the project's own", rel, "")
            if os.path.islink(path):
                continue
            try:
                if os.path.getsize(path) > MAX_BYTES:
                    continue
                with open(path, "rb") as source:
                    data = source.read()
            except OSError:
                continue
            if b"\0" in data:
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if name.lower().endswith(".md"):
                for target in markdown_link_issues(root, rel, text):
                    add("broken or escaping local Markdown links", rel, target)
            for n, line in enumerate(text.splitlines(), 1):
                short = line.strip()[:140]
                if "private:start" in line or "private:end" in line:
                    add("private-section markers left in", rel, f"{n}: {short}")
                if NAMES.search(line) and not allowed(allow, rel, line):
                    add("names of other projects", rel, f"{n}: {short}")
                if rel != "LICENSE" and ATTRIBUTION.search(line) and not allowed(allow, rel, line):
                    add("attribution / licence wording", rel, f"{n}: {short}")
                for label, rx in SECRETS:
                    if rx.search(line) and not allowed(allow, rel, line):
                        add(f"secrets: {label}", rel, f"{n}: (matched, not shown)")
                if PERSONAL.search(line) and not allowed(allow, rel, line):
                    add("personal paths or names", rel, f"{n}: {short}")
                # Internal work history must not be waived via the attribution allow-list.
                if INTERNAL_MARKERS.search(line):
                    add("internal work markers", rel, f"{n}: (matched, not shown)")

    total = sum(len(v) for v in findings.values())
    if not total:
        print("release check: no automated findings. This is not publication approval; manual licence, credential and release reviews remain required.")
        return 0
    print(f"release check: {total} finding(s) in {len(findings)} group(s). Do NOT publish yet.\n")
    for kind, items in sorted(findings.items(), key=lambda kv: -len(kv[1])):
        print(f"## {kind}  ({len(items)})")
        for item in items[:12]:
            print(f"   {item}")
        if len(items) > 12:
            print(f"   … and {len(items) - 12} more")
        print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
