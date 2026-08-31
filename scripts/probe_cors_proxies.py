#!/usr/bin/env python3
"""Diagnostic only. Answers one question a sandbox cannot: which price
sources a *browser* is actually allowed to read.

Reaching a host from a script proves nothing about the app, because the app
runs in a browser and the browser refuses to hand JavaScript a cross-origin
response unless the server sends Access-Control-Allow-Origin. So this checks
two separate things per candidate:

  reachable - did the host answer at all, with usable data
  CORS      - does it send a header that lets the page read that answer

A source can be perfectly reachable here and still be useless in the app.
That is exactly the mistake this script exists to stop repeating.

Run: python scripts/probe_cors_proxies.py
"""
import sys
import time
import urllib.parse

import requests

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 "
              "Safari/537.36")

# The page's real origin on GitHub Pages - CORS answers can depend on it.
ORIGIN = "https://eladnizri.github.io"

YAHOO = ("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC"
         "?interval=1d&range=1d")

CANDIDATES = [
    # (label, url, a string that must appear in the body to count as usable)
    ("yahoo direct", YAHOO, "regularMarketPrice"),
    ("codetabs -> yahoo",
     "https://api.codetabs.com/v1/proxy/?quest=" + urllib.parse.quote(YAHOO, safe=''),
     "regularMarketPrice"),
    ("allorigins -> yahoo",
     "https://api.allorigins.win/raw?url=" + urllib.parse.quote(YAHOO, safe=''),
     "regularMarketPrice"),
    ("corsproxy.io -> yahoo",
     "https://corsproxy.io/?url=" + urllib.parse.quote(YAHOO, safe=''),
     "regularMarketPrice"),
    ("nasdaq quote SPY",
     "https://api.nasdaq.com/api/quote/SPY/info?assetclass=etf",
     "lastSalePrice"),
    ("stooq spy",
     "https://stooq.com/q/l/?s=spy.us&f=sd2t2ohlcv&h&e=csv", "Close"),
    ("stooq ^spx",
     "https://stooq.com/q/l/?s=%5Espx&f=sd2t2ohlcv&h&e=csv", "Close"),
]


def log(msg):
    print(msg, flush=True)


def check(label, url, needle):
    sess = requests.Session()
    sess.headers.update({"User-Agent": BROWSER_UA,
                         "Accept": "application/json, text/plain, */*",
                         "Origin": ORIGIN})
    t0 = time.time()
    try:
        r = sess.get(url, timeout=15)
    except Exception as e:
        log(f"{label:24} EXC {type(e).__name__} after {time.time() - t0:4.1f}s")
        return False, False

    usable = r.status_code == 200 and needle in r.text
    acao = r.headers.get("Access-Control-Allow-Origin")
    # A browser accepts * or an exact echo of this page's origin, nothing else.
    cors_ok = acao == "*" or acao == ORIGIN

    log(f"{label:24} HTTP {r.status_code:3}  {time.time() - t0:4.1f}s  "
        f"data={'yes' if usable else 'NO ':3}  "
        f"ACAO={acao if acao else 'ABSENT'}"
        f"{'' if cors_ok else '   <- a browser cannot read this'}")
    if not usable and r.status_code == 200:
        log(f"{'':24} body[:120] = {r.text[:120]!r}")
    return usable, cors_ok


def main():
    log(f"Origin sent: {ORIGIN}")
    log("")
    winners = []
    for label, url, needle in CANDIDATES:
        usable, cors_ok = check(label, url, needle)
        if usable and cors_ok:
            winners.append(label)
    log("")
    if winners:
        log("USABLE FROM THE APP (reachable AND readable by a browser):")
        for w in winners:
            log(f"  - {w}")
        return 0
    log("NOTHING here is both reachable and browser-readable.")
    log("A source the page can read directly does not currently exist;")
    log("the prices have to be fetched server-side and served from the repo.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
