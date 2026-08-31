#!/usr/bin/env python3
"""Diagnostic only. Checks whether the three public CORS proxies the client
uses to reach Yahoo (fetchRaw's PROXIES list in app.js) are actually up right
now, from a network that is not the reporting user's own.

A user reported the home screen's index tiles failing to update even after
the client-side fix (racing all four candidates instead of trying them one
at a time) landed and was confirmed running. That fix only helps if at least
one candidate answers; if the free proxies themselves are down or blocking
this traffic, no amount of client-side racing helps. This settles which case
it is.

Run: python scripts/probe_cors_proxies.py
"""
import sys
import time
import urllib.parse

import requests

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 "
              "Safari/537.36")

TARGET = ("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC"
          "?interval=1d&range=1d")

PROXIES = [
    ("direct (no proxy)", TARGET),
    ("codetabs", "https://api.codetabs.com/v1/proxy/?quest=" +
     urllib.parse.quote(TARGET, safe='')),
    ("allorigins", "https://api.allorigins.win/raw?url=" +
     urllib.parse.quote(TARGET, safe='')),
    ("corsproxy.io", "https://corsproxy.io/?url=" +
     urllib.parse.quote(TARGET, safe='')),
]


def log(msg):
    print(msg, flush=True)


def main():
    sess = requests.Session()
    sess.headers.update({"User-Agent": BROWSER_UA})
    any_ok = False

    for name, url in PROXIES:
        t0 = time.time()
        try:
            r = sess.get(url, timeout=15)
            elapsed = time.time() - t0
            ok = r.status_code == 200 and '"regularMarketPrice"' in r.text
            log(f"{name:20} HTTP {r.status_code:3}  {elapsed:5.2f}s  "
                f"{'OK, has price' if ok else 'answered, no price in body'}"
                f"  len={len(r.text)}")
            if not ok:
                log(f"{'':20} body[:150] = {r.text[:150]!r}")
            any_ok = any_ok or ok
        except Exception as e:
            elapsed = time.time() - t0
            log(f"{name:20} EXC {type(e).__name__:20} after {elapsed:5.2f}s: {e}")

    log("")
    log("at least one candidate answered with a price" if any_ok
        else "NONE of the four candidates produced a usable quote")
    return 0 if any_ok else 1


if __name__ == "__main__":
    sys.exit(main())
