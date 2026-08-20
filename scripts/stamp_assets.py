#!/usr/bin/env python3
"""Stamp app.js and style.css with a content hash in index.html.

Without this the two are referenced by bare filename, so a browser keeps
serving the copies it already has even after index.html changes - which is why
a deploy could look like it had not happened at all. The hash changes only when
the file changes, so caching still works; it just cannot go stale.

Idempotent: run it twice and the second run reports nothing to do.
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")
ASSETS = ["app.js", "style.css"]


def short_hash(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:10]


def stamp(html, asset, digest):
    """Rewrite every reference to `asset`, with or without an existing ?v=."""
    pattern = re.compile(
        r'((?:src|href)=")' + re.escape(asset) + r'(?:\?v=[0-9a-f]+)?(")')
    return pattern.subn(r'\1' + asset + '?v=' + digest + r'\2', html)


def main():
    if not os.path.exists(INDEX):
        print("index.html not found", file=sys.stderr)
        return 1

    with open(INDEX, encoding="utf-8") as fh:
        html = original = fh.read()

    for asset in ASSETS:
        path = os.path.join(ROOT, asset)
        if not os.path.exists(path):
            print(f"  {asset}: missing, skipped")
            continue
        digest = short_hash(path)
        html, n = stamp(html, asset, digest)
        if not n:
            print(f"  {asset}: no reference in index.html", file=sys.stderr)
            return 1
        print(f"  {asset} -> ?v={digest}  ({n} reference{'s' if n > 1 else ''})")

    # Publish the hashes so a running copy can notice it is out of date.
    # Stamping the assets alone was not enough: index.html carries those
    # stamped URLs and is itself cacheable, so a stale page keeps asking for
    # the old files and never learns a new build exists.
    digests = {}
    for asset in ASSETS:
        path = os.path.join(ROOT, asset)
        if os.path.exists(path):
            digests[asset.split(".")[0]] = short_hash(path)
    version_path = os.path.join(ROOT, "version.json")
    payload = json.dumps(digests, indent=2, sort_keys=True) + "\n"
    old = ""
    if os.path.exists(version_path):
        with open(version_path, encoding="utf-8") as fh:
            old = fh.read()
    if payload != old:
        with open(version_path, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"version.json -> {digests}")

    if html == original:
        print("already current")
        return 0

    with open(INDEX, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("index.html updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
