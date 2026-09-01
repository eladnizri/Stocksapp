#!/usr/bin/env python3
"""Diagnostic only. Which quote APIs can a BROWSER read directly?

Setting up a Cloudflare Worker is a lot of steps for someone who just wants
prices. It is only worth it if there is genuinely no API that a page can call
on its own - so before defending that answer, check.

The bar is not "does it return prices". It is:

  reachable  - the host answered with usable data
  CORS       - it sent Access-Control-Allow-Origin, so the page may read it
  keyless    - no signup, or a signup that ends in a key you paste once

A source that fails the CORS line is useless in the app no matter how good
its data is. Assuming otherwise is the exact mistake that cost this project
two rounds already, so nothing here is trusted without the header printed.

Run: python scripts/probe_browser_apis.py
"""
import sys

import requests

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 "
              "Safari/537.36")

# The page's real origin. CORS answers can and do depend on it.
ORIGIN = "https://eladnizri.github.io"

# (label, url, needle that proves usable data, signup)
CANDIDATES = [
    ("stooq csv",
     "https://stooq.com/q/l/?s=spy.us&f=sd2t2ohlcv&h&e=csv",
     "SPY", "none"),
    ("stooq csv (no www)",
     "https://stooq.pl/q/l/?s=spy.us&f=sd2t2ohlcv&h&e=csv",
     "SPY", "none"),
    ("frankfurter (forex only)",
     "https://api.frankfurter.app/latest?from=USD&to=ILS",
     "ILS", "none"),
    ("exchangerate.host (forex only)",
     "https://api.exchangerate.host/latest?base=USD&symbols=ILS",
     "ILS", "none"),
    ("open.er-api.com (forex only)",
     "https://open.er-api.com/v6/latest/USD",
     "ILS", "none"),
    ("exchangerate-api.com v4 (forex only)",
     "https://api.exchangerate-api.com/v4/latest/USD",
     "ILS", "none"),
    ("coingecko (crypto only)",
     "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
     "usd", "none"),
    ("alphavantage demo key",
     "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=demo",
     "05. price", "free key, 25 req/day"),
    ("twelvedata demo",
     "https://api.twelvedata.com/price?symbol=AAPL&apikey=demo",
     "price", "free key, 800 req/day"),
    ("financialmodelingprep demo",
     "https://financialmodelingprep.com/api/v3/quote-short/AAPL?apikey=demo",
     "price", "free key, 250 req/day"),
    ("finnhub (no key - header check only)",
     "https://finnhub.io/api/v1/quote?symbol=AAPL",
     "", "free key, 60 req/min"),
    ("stockdata.org (no key - header check only)",
     "https://api.stockdata.org/v1/data/quote?symbols=AAPL",
     "", "free key, 100 req/day"),
    ("yahoo direct (control - known to fail)",
     "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1d",
     "regularMarketPrice", "none"),
]


def probe(label, url, needle, signup):
    head = {"User-Agent": BROWSER_UA, "Origin": ORIGIN,
            "Accept": "application/json, text/csv, */*"}
    try:
        r = requests.get(url, headers=head, timeout=20)
    except Exception as e:
        print(f"  {label:38} DEAD          ({type(e).__name__})")
        return None

    acao = r.headers.get("Access-Control-Allow-Origin")
    body = r.text[:400].replace("\n", " ")
    usable = bool(needle) and needle in r.text
    verdict = "READABLE" if acao else "blocked"
    print(f"  {label:38} HTTP {r.status_code}  ACAO={acao or 'ABSENT':10} "
          f"{verdict:9} data={'yes' if usable else ('n/a' if not needle else 'no')}")
    print(f"      signup: {signup}")
    print(f"      body:   {body[:150]}")
    return acao


def main():
    print("Can a browser at", ORIGIN, "read these directly?\n")
    readable = []
    for label, url, needle, signup in CANDIDATES:
        if probe(label, url, needle, signup):
            readable.append(label)
        print()

    print("=" * 70)
    if readable:
        print("Browser-readable:", ", ".join(readable))
    else:
        print("Nothing here is browser-readable. A server-side hop is the only "
              "option, and the Worker stands.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
